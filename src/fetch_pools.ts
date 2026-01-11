import { ethers, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// ================= 配置区域 =================
const RPC_URL = 'http://127.0.0.1:8545';

const BATCH_SIZE = 100; 
const BATCH_DELAY_MS = 10; 

// === ⚖️ V2 阈值定义 ===
const MIN_ETH_LIQUIDITY = 500000000000000000n; // 0.5 ETH (~$1500)
const MIN_USDC_LIQUIDITY = 1500000000n;        // 1500 USDC
const MIN_OTHER_LIQUIDITY = 5000000000000000000000n; 

// === ⚖️ V3 阈值定义 (数学修正版) ===
// 1 ETH ($3000) + 3000 USDC 的 L 约为 5.4e13
// 我们设定两个档位：
// LOW: ~$500 TVL (用于两个都是白名单币的池子) -> 1e13
// HIGH: ~$5000 TVL (用于带土狗的池子，必须深度够厚才算安全) -> 1e14
const MIN_V3_LIQ_LOW = 10000000000000n;   // 1e13 (~$500)
const MIN_V3_LIQ_HIGH = 100000000000000n; // 1e14 (~$5000)

// 白名单配置
const TOKEN_CONFIG: { [key: string]: { decimals: number, type: 'ETH' | 'USD' | 'OTHER' } } = {
    // --- Tier 1: 绝对核心 ---
    '0x4200000000000000000000000000000000000006': { decimals: 18, type: 'ETH' }, // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { decimals: 6, type: 'USD' },  // USDC
    '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': { decimals: 6, type: 'USD' },  // USDbC
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { decimals: 18, type: 'USD' }, // DAI
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': { decimals: 18, type: 'ETH' }, // cbETH

    // --- Tier 2: 热门资产 (Meme & DeFi) ---
    '0x940181a94a35a4569e4529a3cdfb74e38fd98631': { decimals: 18, type: 'OTHER' }, // AERO
    '0x0000206329b97db379d5e1bf586bbdb969c63274': { decimals: 18, type: 'OTHER' }, // bsUSD
    '0x399232699620ddca88632a988b8eb78c59f8ed68': { decimals: 18, type: 'OTHER' }, // VIRTUAL
    '0x4ed4e862860bed51a9570b96d89af5e1b0efefed': { decimals: 18, type: 'OTHER' }, // DEGEN
    '0x532f27101965dd16442e59d40670faf5ebb142e4': { decimals: 18, type: 'OTHER' }, // BRETT
    '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4': { decimals: 18, type: 'OTHER' }, // TOSHI
    '0x2da56acb9ea78330f947bd57c54119debda7af71': { decimals: 18, type: 'OTHER' }, // MOG
    '0x9d90308d16b94c38048c78680663776c5acdf949': { decimals: 18, type: 'OTHER' }, // KEYCAT
};

const isWhitelisted = (addr: string) => Object.keys(TOKEN_CONFIG).includes(addr.toLowerCase());
const getTokenType = (addr: string) => TOKEN_CONFIG[addr.toLowerCase()]?.type || 'UNKNOWN';

const PROTOCOLS = [
    {
        name: 'Aerodrome_V2',
        type: 'v2', 
        factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
        router: '0x9a48954530d54963364f009dc42aa374f14794e7',
        method: 'allPools',
        countMethod: 'allPoolsLength',
        abiType: 'aero_v2'
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
        name: 'Aerodrome_CL', 
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
    console.log("🚀 Starting COMPATIBLE Pool Scanner (Final Strict Mode)...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);
    const allPools: any[] = [];

    for (const proto of PROTOCOLS) {
        console.log(`\n📡 Scanning ${proto.name}...`);
        let poolAddresses: string[] = [];

        // --- 1. 获取地址 ---
        if (proto.method === 'logs') {
            console.log(`   Scanning Logs...`);
            const currentBlock = await provider.getBlockNumber();
            const step = 20000; 
            const iface = new ethers.Interface(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);
            const uniquePools = new Set<string>();

            for (let from = proto.startBlock!; from < currentBlock; from += step) {
                const to = Math.min(from + step, currentBlock);
                try {
                    const logs = await getLogsWithRetry(provider, { address: proto.factory, topics: [V3_FACTORY_TOPIC], fromBlock: from, toBlock: to });
                    logs.forEach(l => { try { uniquePools.add(iface.parseLog(l)!.args.pool); } catch {} });
                } catch (e) {}
                process.stdout.write(`\r   Blocks: ${from}/${currentBlock} | Found: ${uniquePools.size}`);
            }
            poolAddresses = Array.from(uniquePools);
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

        // --- 2. 严格过滤逻辑 ---
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

                            // 🔥 V3 分级过滤策略 (Tiered Filtering)
                            const isT0White = isWhitelisted(t0);
                            const isT1White = isWhitelisted(t1);

                            // 情况 1: 两个都是白名单 (Core Pair) -> 允许较低流动性 (~$500)
                            if (isT0White && isT1White) {
                                if (liq > MIN_V3_LIQ_LOW) valid = true;
                            }
                            // 情况 2: 只有一个是白名单 (Core-Meme) -> 必须有高流动性 (~$5000)
                            // 这能有效过滤掉绝大多数只有 $10-$100 的垃圾空壳池
                            else if ((isT0White || isT1White) && liq > MIN_V3_LIQ_HIGH) {
                                valid = true;
                            }

                        } else { // V2 & Aero
                            let reserves, isStable = false;
                            
                            if (proto.abiType === 'aero_v2') {
                                t0 = aeroV2Iface.decodeFunctionResult('token0', results[idx++])[0];
                                t1 = aeroV2Iface.decodeFunctionResult('token1', results[idx++])[0];
                                reserves = aeroV2Iface.decodeFunctionResult('getReserves', results[idx++]);
                                isStable = aeroV2Iface.decodeFunctionResult('stable', results[idx++])[0];
                                if (isStable) continue; 

                            } else {
                                t0 = v2Iface.decodeFunctionResult('token0', results[idx++])[0];
                                t1 = v2Iface.decodeFunctionResult('token1', results[idx++])[0];
                                reserves = v2Iface.decodeFunctionResult('getReserves', results[idx++]);
                            }

                            const r0 = BigInt(reserves[0]);
                            const r1 = BigInt(reserves[1]);

                            // V2 策略 (保持不变)
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
                    }
                }
            } catch (e) {
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