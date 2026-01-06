import { ethers, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// CONFIGURATION
const RPC_URL = 'http://127.0.0.1:8545';
// const RPC_URL = 'https://mainnet.base.org'
const AERODROME_FACTORY_ADDRESS = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BATCH_SIZE = 1000; // Increased batch size since local node is fast

// FIXED ABIS (Aerodrome Specific: Pairs -> Pools)
const FACTORY_ABI = [
    // Aerodrome uses 'allPools' instead of 'allPairs'
    'function allPoolsLength() view returns (uint256)',
    'function allPools(uint256) view returns (address)'
];

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function symbol() view returns (string)'
];

const MULTICALL_ABI = [
    'function aggregate(tuple(address target, bytes callData)[] calls) public view returns (uint256 blockNumber, bytes[] returnData)'
];

interface PoolData {
    index: number;
    address: string;
    token0: string;
    token1: string;
    reserve0: string;
    reserve1: string;
}

async function main() {
    console.log("Connecting to Base Node...");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // 1. Diagnostics
    try {
        const blockNumber = await provider.getBlockNumber();
        console.log(`✅ Node Synced at Block: ${blockNumber}`);
    } catch (error) {
        console.error("❌ Node Connection Failed");
        process.exit(1);
    }

    const factory = new Contract(AERODROME_FACTORY_ADDRESS, FACTORY_ABI, provider);
    const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);

    // 2. Get total number of pools
    console.log("Fetching total pool count...");
    try {
        // Changed to allPoolsLength
        const totalPoolsBigInt = await factory.allPoolsLength(); 
        const totalPools = Number(totalPoolsBigInt);
        console.log(`🎯 Total Aerodrome Pools found: ${totalPools}`);

        const allPools: PoolData[] = [];
        const pairInterface = new ethers.Interface(PAIR_ABI);
        const factoryInterface = new ethers.Interface(FACTORY_ABI);

        // 3. Loop through in batches
        for (let i = 0; i < totalPools; i += BATCH_SIZE) {
            const end = Math.min(i + BATCH_SIZE, totalPools);
            console.log(`Processing batch: ${i} to ${end - 1}...`);

            // Step A: Get Pool Addresses
            const addressCalls = [];
            for (let j = i; j < end; j++) {
                addressCalls.push({
                    target: AERODROME_FACTORY_ADDRESS,
                    // Changed to allPools
                    callData: factoryInterface.encodeFunctionData('allPools', [j]) 
                });
            }

            try {
                const [, returnDataAddresses] = await multicall.aggregate(addressCalls);
                
                const poolAddresses: string[] = returnDataAddresses.map((bytes: string) => 
                    factoryInterface.decodeFunctionResult('allPools', bytes)[0]
                );

                // Step B: Get Pool Details
                const detailCalls = [];
                for (const poolAddr of poolAddresses) {
                    detailCalls.push({ target: poolAddr, callData: pairInterface.encodeFunctionData('token0', []) });
                    detailCalls.push({ target: poolAddr, callData: pairInterface.encodeFunctionData('token1', []) });
                    detailCalls.push({ target: poolAddr, callData: pairInterface.encodeFunctionData('getReserves', []) });
                }

                const [, returnDataDetails] = await multicall.aggregate(detailCalls);

                for (let k = 0; k < poolAddresses.length; k++) {
                    const baseIndex = k * 3;
                    if (returnDataDetails[baseIndex] === '0x') continue;

                    try {
                        const t0 = pairInterface.decodeFunctionResult('token0', returnDataDetails[baseIndex])[0];
                        const t1 = pairInterface.decodeFunctionResult('token1', returnDataDetails[baseIndex + 1])[0];
                        const res = pairInterface.decodeFunctionResult('getReserves', returnDataDetails[baseIndex + 2]);

                        allPools.push({
                            index: i + k,
                            address: poolAddresses[k],
                            token0: t0,
                            token1: t1,
                            reserve0: res[0].toString(),
                            reserve1: res[1].toString()
                        });
                    } catch (e) { 
                        // Sometime pools are broken or empty, skip them
                    }
                }

            } catch (err) {
                console.error(`Batch failed at index ${i}:`, err);
            }
        }

        const outputPath = path.join(__dirname, '../aerodrome_pools_full.json');
        console.log(`✅ Successfully scanned ${allPools.length} pools.`);
        fs.writeFileSync(outputPath, JSON.stringify(allPools, null, 2));
        console.log(`Data saved to ${outputPath}`);

    } catch (err) {
        console.error("❌ Error calling Factory:", err);
        console.log("Check if 'allPoolsLength' is the correct function name for this contract.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});