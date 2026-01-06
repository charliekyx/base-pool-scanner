import { ethers, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { SingleBar, Presets } from 'cli-progress';

// ================= 配置区域 =================
const RPC_URL = 'http://127.0.0.1:8545';
// const RPC_URL = 'https://mainnet.base.org'
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
    // 1. Aerodrome Legacy (V2) - 只抓取 Volatile 池子
    {
        name: 'Aerodrome_V2',
        type: 'v2', // 对应 Rust protocol = 1
        factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
        router: '0x9a48954530d54963364f009dc42aa374f14794e7', // Aero Router
        method: 'allPools',
        countMethod: 'allPoolsLength',
        abiType: 'aero_v2' // 特殊标记：需要检查 stable()
    },
    // 2. BaseSwap (Standard V2) - Base 上最大的纯 V2 DEX
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
        type: 'cl', // 对应 Rust protocol = 2
        factory: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A', // Slipstream Factory
        router: '0xBE818bA15c43dF60803c40026e6E367258C17e33', // Universal Router
        quoter: '0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0',
        method: 'allPools',
        countMethod: 'allPoolsLength',
        abiType: 'v3'
    },
    // 4. Uniswap V3
    {
        name: 'Uniswap_V3',
        type: 'v3', // 对应 Rust protocol = 0
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

// V3 / CL Pools
const V3_POOL_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function fee() view returns (uint24)',
    'function tickSpacing() view returns (int24)',
    'function liquidity() view returns (uint128)'
];

// Standard V2 Pairs
const V2_PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

// Aerodrome V2 (Legacy) - 有 stable 字段
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
    quoter?: String, // For V2, this stores the Pool Address!
    pool?: String,   // For V3/CL, this stores the Pool Address
    fee?: number,
    tick_spacing?: number,
    pool_fee?: number,
    protocol: String
}

async function main() {
    console.log("🚀 Starting V2/V3/CL Hybrid Pool Scanner...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Test Connection
    try { await provider.getNetwork(); } catch (e) {
        console.error("❌ Failed to connect to node."); process.exit(1);
    }

    const allPools: PoolOutput[] = [];
    const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);

    for (const proto of PROTOCOLS) {
        console.log(`\n📡 Scanning Protocol: ${proto.name} (${proto.type})...`);
        let poolAddresses: string[] = [];

        // === Step 1: 获取池子地址列表 ===
        if (proto.method === 'logs') {
            // Log Scanning logic for Uniswap V3 (省略细节，同上，快速实现)
            console.log(`   Scanning V3 Logs...`);
            const currentBlock = await provider.getBlockNumber();
            const step = 50000; 
            const bar = new SingleBar({}, Presets.shades_classic);
            bar.start(currentBlock - proto.startBlock!, 0);

            for (let from = proto.startBlock!; from < currentBlock; from += step) {
                const to = Math.min(from + step, currentBlock);
                const logs = await provider.getLogs({
                    address: proto.factory,
                    topics: [V3_FACTORY_TOPIC],
                    fromBlock: from,
                    toBlock: to
                });
                const iface = new ethers.Interface(["event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"]);
                for (const log of logs) {
                    try {
                        const parsed = iface.parseLog(log);
                        if (parsed) poolAddresses.push(parsed.args.pool);
                    } catch(e) {}
                }
                bar.update(from - proto.startBlock!);
            }
            bar.stop();
        } else {
            // Factory Enumeration
            const factory = new Contract(proto.factory, FACTORY_ABI, provider);
            // @ts-ignore
            const count = Number(await factory[proto.countMethod]());
            console.log(`   Factory reports ${count} pools.`);
            
            // Multicall fetch addresses
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

        // === Step 2: 批量获取详情并过滤 ===
        console.log(`   Fetching details for ${poolAddresses.length} pools...`);
        const v3Iface = new ethers.Interface(V3_POOL_ABI);
        const v2Iface = new ethers.Interface(V2_PAIR_ABI);
        const aeroV2Iface = new ethers.Interface(AERO_V2_PAIR_ABI);

        for (let i = 0; i < poolAddresses.length; i += BATCH_SIZE) {
            const batchAddrs = poolAddresses.slice(i, i + BATCH_SIZE);
            const calls = [];

            // Prepare calls based on ABI type
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
                } else { // std_v2 (BaseSwap)
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
                                poolData = { fee, tick_spacing: ts, pool_fee: fee }; // for Rust
                            }

                        } else if (proto.abiType === 'aero_v2') {
                            t0 = aeroV2Iface.decodeFunctionResult('token0', results[resultIdx++])[0];
                            t1 = aeroV2Iface.decodeFunctionResult('token1', results[resultIdx++])[0];
                            const reserves = aeroV2Iface.decodeFunctionResult('getReserves', results[resultIdx++]);
                            const isStable = aeroV2Iface.decodeFunctionResult('stable', results[resultIdx++])[0];

                            // 你的 Rust 代码不支持 stable (混合曲线)，只支持 volatile (xyz=k)
                            // 且 Reserves 必须大于一定值才值得跑
                            if (!isStable && BigInt(reserves[0]) > 1000n && BigInt(reserves[1]) > 1000n) {
                                valid = true;
                            }

                        } else { // std_v2
                            t0 = v2Iface.decodeFunctionResult('token0', results[resultIdx++])[0];
                            t1 = v2Iface.decodeFunctionResult('token1', results[resultIdx++])[0];
                            const reserves = v2Iface.decodeFunctionResult('getReserves', results[resultIdx++]);

                            if (BigInt(reserves[0]) > 1000n && BigInt(reserves[1]) > 1000n) {
                                valid = true;
                            }
                        }

                        // 白名单过滤 (任意一方是白名单代币即可)
                        if (valid && (WHITELIST_TOKENS.has(t0) || WHITELIST_TOKENS.has(t1))) {
                            const name = `${proto.name}_${t0.slice(0,6)}_${poolAddr.slice(38)}`;
                            
                            // === 核心 Rust 兼容逻辑 ===
                            // V2 协议: 将 pool 地址放入 'quoter' 字段
                            // V3/CL 协议: 将 pool 地址放入 'pool' 字段
                            let output: PoolOutput = {
                                name,
                                token_a: t0,
                                token_b: t1,
                                router: proto.router!,
                                protocol: proto.type,
                                ...poolData
                            };

                            if (proto.type === 'v2') {
                                output.quoter = poolAddr; // Rust logic: if protocol==1, pool addr is in quoter
                                output.fee = 3000; // V2 default fee (0.3%) just for config
                            } else {
                                output.quoter = proto.quoter;
                                output.pool = poolAddr;
                            }

                            allPools.push(output);
                        }

                    } catch (e) {
                        // decode error, skip
                        // console.log(e);
                    }
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