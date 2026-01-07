import { ethers, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { SingleBar, Presets } from 'cli-progress';

// ================= 配置区域 =================
const RPC_URL = 'http://127.0.0.1:8545';
const BATCH_SIZE = 500;

// 核心白名单代币 (用于判断池子质量)
const WHITELIST_TOKENS = new Set([
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // USDbC
    '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
    '0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', // cbETH
    '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
    '0x0000206329b97DB379d5E1Bf586BbDB969C63274', // bsUSD (BaseSwap)
]);

// 协议列表
const PROTOCOLS = [
    // 1. Aerodrome Legacy (V2)
    {
        name: 'Aerodrome_V2',
        type: 'v2', 
        factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
        router: '0x9a48954530d54963364f009dc42aa374f14794e7',
        method: 'allPools',
        countMethod: 'allPoolsLength',
        abiType: 'aero_v2'
    },
    // 2. BaseSwap (V2)
    {
        name: 'BaseSwap',
        type: 'v2',
        factory: '0xFDa619b6d20975be80A10332cD39b9a4b0FAa8BB',
        router: '0x2943Ac1216979590F21832bb58459d646b5E4857',
        method: 'allPairs',
        countMethod: 'allPairsLength',
        abiType: 'std_v2'
    },
    // 3. Aerodrome Slipstream (CL/V3)
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
    // 4. Uniswap V3
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

// ================= ABIs =================
const MULTICALL_ABI = [
    'function aggregate(tuple(address target, bytes callData)[] calls) public view returns (uint256 blockNumber, bytes[] returnData)'
];

const V3_POOL_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function tickSpacing() view returns (int24)',
    'function liquidity() view returns (uint128)'
];

const V2_PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const AERO_V2_PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function stable() view returns (bool)'
];

const FACTORY_ABI = [
    'function allPoolsLength() view returns (uint256)',
    'function allPools(uint256) view returns (address)',
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)'
];

const V3_FACTORY_TOPIC = ethers.id("PoolCreated(address,address,uint24,int24,address)");

interface PoolOutput {
    name: String,
    token_a: String,
    token_b: String,
    router: String,
    quoter?: String,
    pool?: String,
    fee?: number,
    tick_spacing?: number,
    pool_fee?: number,
    protocol: String
}

// 辅助函数：带重试机制的 getLogs
async function getLogsWithRetry(provider: ethers.JsonRpcProvider, filter: any, retries = 5): Promise<any[]> {
    for (let i = 0; i < retries; i++) {
        try {
            return await provider.getLogs(filter);
        } catch (error: any) {
            // 如果是超时(-32002)或者其他网络错误，则重试
            if (i === retries - 1) throw error; // 最后一次尝试失败，抛出异常
            
            const delay = 2000 * (i + 1); // 递增延迟: 2s, 4s, 6s...
            // 可以在这里打印日志，但为了界面整洁暂时注释掉
            // console.log(`\n⚠️  Log scan timeout, retrying in ${delay}ms...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    return [];
}

async function main() {
    console.log("🚀 Starting V2/V3/CL Hybrid Pool Scanner (Stable Mode)...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    try { await provider.getNetwork(); } catch (e) {
        console.error("❌ Failed to connect to node."); process.exit(1);
    }

    const allPools: PoolOutput[] = [];
    const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);

    for (const proto of PROTOCOLS) {
        console.log(`\n📡 Scanning Protocol: ${proto.name} (${proto.type})...`);
        let poolAddresses: string[] = [];

        if (proto.method === 'logs') {
            // === V3 Log Scanning (Optimized) ===
            console.log(`   Scanning V3 Logs (Batch Size: 5000, Auto-Retry Enabled)...`);
            const currentBlock = await provider.getBlockNumber();
            
            // 核心修改：大幅减小 Step，防止 Timeout
            const step = 5000; 
            
            const bar = new SingleBar({}, Presets.shades_classic);
            bar.start(currentBlock - proto.startBlock!, 0);

            const iface = new ethers.Interface(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);

            for (let from = proto.startBlock!; from < currentBlock; from += step) {
                const to = Math.min(from + step, currentBlock);
                
                try {
                    // 使用重试机制获取日志
                    const logs = await getLogsWithRetry(provider, {
                        address: proto.factory,
                        topics: [V3_FACTORY_TOPIC],
                        fromBlock: from,
                        toBlock: to
                    });

                    for (const log of logs) {
                        try {
                            const parsed = iface.parseLog(log);
                            if (parsed) poolAddresses.push(parsed.args.pool);
                        } catch(e) {}
                    }
                } catch (err) {
                    console.error(`\n❌ Critical Error scanning blocks ${from}-${to}:`, err);
                    // 继续还是退出？为了数据完整性，这里选择继续，但打印错误
                }
                
                bar.update(from - proto.startBlock!);
            }
            bar.stop();
        } else {
            // === Factory Enumeration (Aerodrome/BaseSwap) ===
            const factory = new Contract(proto.factory, FACTORY_ABI, provider);
            // @ts-ignore
            const count = Number(await factory[proto.countMethod]());
            console.log(`   Factory reports ${count} pools.`);
            
            const bar = new SingleBar({}, Presets.shades_classic);
            bar.start(count, 0);
            const factoryIface = new ethers.Interface(FACTORY_ABI);
            
            for (let i = 0; i < count; i += BATCH_SIZE) {
                const end = Math.min(i + BATCH_SIZE, count);
                const calls = [];
                for (let j = i; j < end; j++) {
                    calls.push({ target: proto.factory, callData: factoryIface.encodeFunctionData(proto.method, [j]) });
                }
                const [, results] = await multicall.aggregate(calls);
                results.forEach((r: string) => {
                    poolAddresses.push(factoryIface.decodeFunctionResult(proto.method, r)[0]);
                });
                bar.update(end);
            }
            bar.stop();
        }

        // === 批量获取详情并过滤 ===
        console.log(`   Fetching details for ${poolAddresses.length} pools...`);
        const v3Iface = new ethers.Interface(V3_POOL_ABI);
        const v2Iface = new ethers.Interface(V2_PAIR_ABI);
        const aeroV2Iface = new ethers.Interface(AERO_V2_PAIR_ABI);

        for (let i = 0; i < poolAddresses.length; i += BATCH_SIZE) {
            const batchAddrs = poolAddresses.slice(i, i + BATCH_SIZE);
            const calls = [];

            for (const addr of batchAddrs) {
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
                let resultIdx = 0;

                for (let k = 0; k < batchAddrs.length; k++) {
                    const poolAddr = batchAddrs[k];
                    try {
                        let t0, t1, valid = false;
                        let poolData: any = {};

                        if (proto.abiType === 'v3') {
                            t0 = v3Iface.decodeFunctionResult('token0', results[resultIdx++])[0];
                            t1 = v3Iface.decodeFunctionResult('token1', results[resultIdx++])[0];
                            const liq = BigInt(v3Iface.decodeFunctionResult('liquidity', results[resultIdx++])[0]);
                            const fee = Number(v3Iface.decodeFunctionResult('fee', results[resultIdx++])[0]);
                            const ts = Number(v3Iface.decodeFunctionResult('tickSpacing', results[resultIdx++])[0]);

                            if (liq > 0n) {
                                valid = true;
                                poolData = { fee, tick_spacing: ts, pool_fee: fee };
                            }

                        } else if (proto.abiType === 'aero_v2') {
                            t0 = aeroV2Iface.decodeFunctionResult('token0', results[resultIdx++])[0];
                            t1 = aeroV2Iface.decodeFunctionResult('token1', results[resultIdx++])[0];
                            const reserves = aeroV2Iface.decodeFunctionResult('getReserves', results[resultIdx++]);
                            const isStable = aeroV2Iface.decodeFunctionResult('stable', results[resultIdx++])[0];

                            if (!isStable && BigInt(reserves[0]) > 1000n && BigInt(reserves[1]) > 1000n) {
                                valid = true;
                            }

                        } else { 
                            t0 = v2Iface.decodeFunctionResult('token0', results[resultIdx++])[0];
                            t1 = v2Iface.decodeFunctionResult('token1', results[resultIdx++])[0];
                            const reserves = v2Iface.decodeFunctionResult('getReserves', results[resultIdx++]);

                            if (BigInt(reserves[0]) > 1000n && BigInt(reserves[1]) > 1000n) {
                                valid = true;
                            }
                        }

                        if (valid && (WHITELIST_TOKENS.has(t0) || WHITELIST_TOKENS.has(t1))) {
                            const name = `${proto.name}_${t0.slice(0,6)}_${poolAddr.slice(38)}`;
                            let output: PoolOutput = {
                                name,
                                token_a: t0,
                                token_b: t1,
                                router: proto.router!,
                                protocol: proto.type,
                                ...poolData
                            };

                            if (proto.type === 'v2') {
                                output.quoter = poolAddr;
                                output.fee = 3000; 
                            } else {
                                output.quoter = proto.quoter;
                                output.pool = poolAddr;
                            }

                            allPools.push(output);
                        }

                    } catch (e) {}
                }

            } catch (err) {
                console.error(`Batch failed: ${err}`);
            }
            process.stdout.write(`\r   Processed ${Math.min(i + BATCH_SIZE, poolAddresses.length)} pools...`);
        }
        console.log(`\n   ✅ Added valid pools.`);
    }

    const outputPath = path.join(__dirname, '../pools.json');
    fs.writeFileSync(outputPath, JSON.stringify(allPools, null, 4));
    console.log(`\n🎉 Done! Saved ${allPools.length} pools to pools.json`);
}

main().catch(console.error);