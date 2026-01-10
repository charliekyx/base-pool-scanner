import { ethers, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { SingleBar, Presets } from 'cli-progress';

// ================= 配置区域 =================
const RPC_URL = 'http://127.0.0.1:8545';

const BATCH_SIZE = 100; 
const BATCH_DELAY_MS = 50;

// === ⚖️ 阈值定义 (既要精品，又不能太少) ===
// 0.5 ETH (降低一点门槛，抓取中型池子)
const MIN_ETH_LIQUIDITY = 500000000000000000n; 
// 1000 USDC
const MIN_USDC_LIQUIDITY = 1000000000n; 
// 其他币种至少要有 5000 单位的储备 (防止完全空壳)
const MIN_OTHER_LIQUIDITY = 5000000000000000000000n; 

// 核心白名单代币 (Base 链主要资产)
// 你的 Rust Bot 应该主要针对这些资产进行套利
const TOKEN_CONFIG: { [key: string]: { decimals: number, type: 'ETH' | 'USD' | 'OTHER' } } = {
    '0x4200000000000000000000000000000000000006': { decimals: 18, type: 'ETH' }, // WETH
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': { decimals: 6, type: 'USD' },  // USDC
    '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA': { decimals: 6, type: 'USD' },  // USDbC
    '0x940181a94A35A4569E4529A3CDfB74e38FD98631': { decimals: 18, type: 'OTHER' }, // AERO
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { decimals: 18, type: 'ETH' }, // cbETH
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb': { decimals: 18, type: 'USD' },  // DAI
    '0x0000206329b97DB379d5E1Bf586BbDB969C63274': { decimals: 18, type: 'OTHER' }, // bsUSD
    '0x399232699620ddca88632a988b8eb78c59f8ed68': { decimals: 18, type: 'OTHER' }, // VIRTUAL (最近很火，加上)
};

const isWhitelisted = (addr: string) => Object.keys(TOKEN_CONFIG).includes(addr.toLowerCase());
const getTokenType = (addr: string) => TOKEN_CONFIG[addr.toLowerCase()]?.type || 'UNKNOWN';

// 协议列表
const PROTOCOLS = [
    {
        name: 'Aerodrome_V2',
        type: 'v2', 
        factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
        router: '0x9a48954530d54963364f009dc42aa374f14794e7',
        method: 'allPools',
        countMethod: 'allPoolsLength',
        abiType: 'aero_v2' // 特殊处理 Aero
    },
    {
        name: 'BaseSwap',
        type: 'v2',
        factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
        router: '0x2943Ac1216979590F21832bb58459d646b5E4857',
        method: 'allPairs',
        countMethod: 'allPairsLength',
        abiType: 'std_v2'
    },
    {
        name: 'Aerodrome_CL', // 这是 Aero 的 V3 (集中流动性)，算法同 Uniswap V3，Rust 可支持
        type: 'cl', 
        factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', 
        router: '0xBE818bA15c43dF60803c40026e6E367258C17e33', 
        quoter: '0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0',
        method: 'allPools',
        countMethod: 'allPoolsLength',
        abiType: 'v3'
    },
    {
        name: 'Uniswap_V3',
        type: 'v3',
        factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
        router: '0x2626664c2603336E57B271c5C0b26F421741e481',
        quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
        method: 'logs',
        startBlock: 2000000,
        abiType: 'v3'
    }
];

const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ABIs
const MULTICALL_ABI = ['function aggregate(tuple(address target, bytes callData)[] calls) public view returns (uint256 blockNumber, bytes[] returnData)'];
const V3_POOL_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function fee() view returns (uint24)', 'function tickSpacing() view returns (int24)', 'function liquidity() view returns (uint128)'];
const V2_PAIR_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'];
// Aero 需要这一句 stable() 来区分
const AERO_V2_PAIR_ABI = ['function token0() view returns (address)', 'function token1() view returns (address)', 'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)', 'function stable() view returns (bool)'];
const FACTORY_ABI = ['function allPoolsLength() view returns (uint256)', 'function allPools(uint256) view returns (address)', 'function allPairsLength() view returns (uint256)', 'function allPairs(uint256) view returns (address)'];
const V3_FACTORY_TOPIC = ethers.id("PoolCreated(address,address,uint24,int24,address)");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getLogsWithRetry(provider: ethers.JsonRpcProvider, filter: any, retries = 5): Promise<any[]> {
    for (let i = 0; i < retries; i++) {
        try { return await provider.getLogs(filter); } catch (e) { await sleep(1000); }
    }
    return [];
}

async function main() {
    console.log("🚀 Starting COMPATIBLE Pool Scanner (No Stable Pools)...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
    const allPools: any[] = [];

    for (const proto of PROTOCOLS) {
        console.log(`\n📡 Scanning ${proto.name}...`);
        let poolAddresses: string[] = [];

        // --- 1. 获取所有池子地址 ---
        if (proto.method === 'logs') {
            console.log(`   Scanning Logs...`);
            const currentBlock = await provider.getBlockNumber();
            const step = 10000; 
            const iface = new ethers.Interface(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);
            for (let from = proto.startBlock!; from < currentBlock; from += step) {
                const to = Math.min(from + step, currentBlock);
                try {
                    const logs = await getLogsWithRetry(provider, { address: proto.factory, topics: [V3_FACTORY_TOPIC], fromBlock: from, toBlock: to });
                    logs.forEach(l => { try { poolAddresses.push(iface.parseLog(l)!.args.pool); } catch {} });
                } catch (e) {}
                process.stdout.write(`\r   Blocks: ${from}/${currentBlock} | Found: ${poolAddresses.length}`);
            }
            console.log("");
        } else {
            const factory = new Contract(proto.factory, FACTORY_ABI, provider);
            // @ts-ignore
            const count = Number(await factory[proto.countMethod]());
            console.log(`   Factory count: ${count}`);
            const factoryIface = new ethers.Interface(FACTORY_ABI);
            for (let i = 0; i < count; i += 500) { 
                const end = Math.min(i + 500, count);
                const calls = [];
                for (let j = i; j < end; j++) calls.push({ target: proto.factory, callData: factoryIface.encodeFunctionData(proto.method, [j]) });
                const [, res] = await multicall.aggregate(calls);
                res.forEach((r: string) => poolAddresses.push(factoryIface.decodeFunctionResult(proto.method, r)[0]));
                process.stdout.write(`\r   Fetched addresses: ${poolAddresses.length}`);
            }
            console.log("");
        }

        // --- 2. 批量过滤逻辑 (重点修复区域) ---
        console.log(`   Filtering ${poolAddresses.length} pools...`);
        const v3Iface = new ethers.Interface(V3_POOL_ABI);
        const v2Iface = new ethers.Interface(V2_PAIR_ABI);
        const aeroV2Iface = new ethers.Interface(AERO_V2_PAIR_ABI);
        
        let kept = 0;

        for (let i = 0; i < poolAddresses.length; i += BATCH_SIZE) {
            const batch = poolAddresses.slice(i, i + BATCH_SIZE);
            const calls = [];

            for (const addr of batch) {
                if (proto.abiType === 'v3') {
                    calls.push({ target: addr, callData: v3Iface.encodeFunctionData('token0', []) });
                    calls.push({ target: addr, callData: v3Iface.encodeFunctionData('token1', []) });
                    calls.push({ target: addr, callData: v3Iface.encodeFunctionData('liquidity', []) });
                    calls.push({ target: addr, callData: v3Iface.encodeFunctionData('fee', []) });
                    calls.push({ target: addr, callData: v3Iface.encodeFunctionData('tickSpacing', []) });
                } else if (proto.abiType === 'aero_v2') {
                    calls.push({ target: addr, callData: aeroV2Iface.encodeFunctionData('token0', []) });
                    calls.push({ target: addr, callData: aeroV2Iface.encodeFunctionData('token1', []) });
                    calls.push({ target: addr, callData: aeroV2Iface.encodeFunctionData('getReserves', []) });
                    // 🔥 关键：一定要取 stable 字段
                    calls.push({ target: addr, callData: aeroV2Iface.encodeFunctionData('stable', []) });
                } else {
                    calls.push({ target: addr, callData: v2Iface.encodeFunctionData('token0', []) });
                    calls.push({ target: addr, callData: v2Iface.encodeFunctionData('token1', []) });
                    calls.push({ target: addr, callData: v2Iface.encodeFunctionData('getReserves', []) });
                }
            }

            try {
                const [, results] = await multicall.aggregate(calls);
                let idx = 0;

                for (const poolAddr of batch) {
                    try {
                        let t0 = '', t1 = '', valid = false, extraData = {};

                        if (proto.abiType === 'v3') {
                            t0 = v3Iface.decodeFunctionResult('token0', results[idx++])[0];
                            t1 = v3Iface.decodeFunctionResult('token1', results[idx++])[0];
                            const liq = BigInt(v3Iface.decodeFunctionResult('liquidity', results[idx++])[0]);
                            const fee = Number(v3Iface.decodeFunctionResult('fee', results[idx++])[0]);
                            const ts = Number(v3Iface.decodeFunctionResult('tickSpacing', results[idx++])[0]);
                            extraData = { fee, tick_spacing: ts, pool_fee: fee };

                            // V3 策略：必须有两个白名单代币，才认为是“精品蓝筹”
                            // 否则 V3 上全是垃圾
                            if (liq > 1000n && isWhitelisted(t0) && isWhitelisted(t1)) {
                                valid = true;
                            }

                        } else { // V2 & Aero
                            let reserves, isStable = false;
                            
                            if (proto.abiType === 'aero_v2') {
                                t0 = aeroV2Iface.decodeFunctionResult('token0', results[idx++])[0];
                                t1 = aeroV2Iface.decodeFunctionResult('token1', results[idx++])[0];
                                reserves = aeroV2Iface.decodeFunctionResult('getReserves', results[idx++]);
                                isStable = aeroV2Iface.decodeFunctionResult('stable', results[idx++])[0];
                                
                                // ❌❌❌ 核心修改：如果是 Stable Pool，直接跳过！❌❌❌
                                // 你的 Rust Bot 算不对这种池子，必须剔除
                                if (isStable) {
                                    continue; 
                                }

                            } else {
                                t0 = v2Iface.decodeFunctionResult('token0', results[idx++])[0];
                                t1 = v2Iface.decodeFunctionResult('token1', results[idx++])[0];
                                reserves = v2Iface.decodeFunctionResult('getReserves', results[idx++]);
                            }

                            const r0 = BigInt(reserves[0]);
                            const r1 = BigInt(reserves[1]);

                            // V2 策略：稍微放宽，只要有一边是白名单，且深度够
                            if (isWhitelisted(t0)) {
                                const type = getTokenType(t0);
                                if (type === 'ETH' && r0 >= MIN_ETH_LIQUIDITY) valid = true;
                                if (type === 'USD' && r0 >= MIN_USDC_LIQUIDITY) valid = true;
                                if (type === 'OTHER' && r0 >= MIN_OTHER_LIQUIDITY) valid = true;
                            }
                            if (!valid && isWhitelisted(t1)) {
                                const type = getTokenType(t1);
                                if (type === 'ETH' && r1 >= MIN_ETH_LIQUIDITY) valid = true;
                                if (type === 'USD' && r1 >= MIN_USDC_LIQUIDITY) valid = true;
                                if (type === 'OTHER' && r1 >= MIN_OTHER_LIQUIDITY) valid = true;
                            }
                        }

                        if (valid) {
                            allPools.push({
                                name: `${proto.name}_${t0.slice(0,6)}_${t1.slice(0,6)}`,
                                token_a: t0,
                                token_b: t1,
                                router: proto.router,
                                protocol: proto.type,
                                quoter: proto.type === 'v2' ? poolAddr : proto.quoter,
                                pool: proto.type === 'v3' || proto.type === 'cl' ? poolAddr : undefined,
                                ...extraData
                            });
                            kept++;
                        }
                    } catch (e) {
                        // decode 失败（比如蜜罐修改了 ABI），直接跳过
                    }
                }
            } catch (e) {
                // Batch 失败
            }
            
            process.stdout.write(`\r   Checked ${Math.min(i + BATCH_SIZE, poolAddresses.length)} | ✅ Kept: ${kept}`);
            await sleep(BATCH_DELAY_MS);
        }
        console.log("");
    }

    const outputPath = path.join(__dirname, '../pools.json');
    fs.writeFileSync(outputPath, JSON.stringify(allPools, null, 4));
    console.log(`\n🎉 Final Clean Count: ${allPools.length} pools saved.`);
}

main();