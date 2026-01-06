import { ethers, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// CONFIGURATION
// Replace with your local node RPC URL
const RPC_URL = 'http://127.0.0.1:8545';
const AERODROME_FACTORY_ADDRESS = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
// Multicall3 Address on Base
const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// Batch size configuration
// 500 is safe for local IPC/HTTP connections
const BATCH_SIZE = 500;

// ABI Definitions
const FACTORY_ABI = [
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)'
];

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

const MULTICALL_ABI = [
    'struct Call { address target; bytes callData; }',
    'function aggregate(Call[] calls) public view returns (uint256 blockNumber, bytes[] returnData)'
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
    
    // Initialize provider
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    
    // Check connection
    try {
        const network = await provider.getNetwork();
        console.log(`Connected to network: ${network.name} (Chain ID: ${network.chainId})`);
    } catch (error) {
        console.error("Failed to connect to local node. Check RPC_URL.");
        process.exit(1);
    }

    const factory = new Contract(AERODROME_FACTORY_ADDRESS, FACTORY_ABI, provider);
    const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);

    // 1. Get total number of pairs
    console.log("Fetching total pair count...");
    const totalPairsBigInt = await factory.allPairsLength();
    const totalPairs = Number(totalPairsBigInt);
    console.log(`Total Aerodrome Pools found: ${totalPairs}`);

    const allPools: PoolData[] = [];
    const pairInterface = new ethers.Interface(PAIR_ABI);

    // 2. Loop through in batches
    for (let i = 0; i < totalPairs; i += BATCH_SIZE) {
        const end = Math.min(i + BATCH_SIZE, totalPairs);
        console.log(`Processing batch: ${i} to ${end - 1}...`);

        // Step A: Prepare calls to get Pool Addresses (allPairs)
        const addressCalls = [];
        for (let j = i; j < end; j++) {
            addressCalls.push({
                target: AERODROME_FACTORY_ADDRESS,
                callData: factory.interface.encodeFunctionData('allPairs', [j])
            });
        }

        try {
            // Execute Multicall for Addresses
            const [, returnDataAddresses] = await multicall.aggregate(addressCalls);
            
            // Decode Pool Addresses
            const poolAddresses: string[] = returnDataAddresses.map((bytes: string) => 
                factory.interface.decodeFunctionResult('allPairs', bytes)[0]
            );

            // Step B: Prepare calls to get Pool Details (token0, token1, reserves)
            const detailCalls = [];

            for (const poolAddr of poolAddresses) {
                detailCalls.push({
                    target: poolAddr,
                    callData: pairInterface.encodeFunctionData('token0', [])
                });
                detailCalls.push({
                    target: poolAddr,
                    callData: pairInterface.encodeFunctionData('token1', [])
                });
                detailCalls.push({
                    target: poolAddr,
                    callData: pairInterface.encodeFunctionData('getReserves', [])
                });
            }

            // Execute Multicall for Details
            const [, returnDataDetails] = await multicall.aggregate(detailCalls);

            // Decode Details and Construct Object
            for (let k = 0; k < poolAddresses.length; k++) {
                const baseIndex = k * 3;
                
                // Check if the call was successful (not empty bytes)
                if (returnDataDetails[baseIndex] === '0x') continue;

                try {
                    const token0 = pairInterface.decodeFunctionResult('token0', returnDataDetails[baseIndex])[0];
                    const token1 = pairInterface.decodeFunctionResult('token1', returnDataDetails[baseIndex + 1])[0];
                    const reserves = pairInterface.decodeFunctionResult('getReserves', returnDataDetails[baseIndex + 2]);

                    allPools.push({
                        index: i + k,
                        address: poolAddresses[k],
                        token0: token0,
                        token1: token1,
                        reserve0: reserves[0].toString(),
                        reserve1: reserves[1].toString()
                    });
                } catch (decodeError) {
                    console.error(`Error decoding pool ${poolAddresses[k]}:`, decodeError);
                }
            }

        } catch (err) {
            console.error(`Batch failed at index ${i}:`, err);
        }
    }

    // 3. Save to file
    const outputPath = path.join(__dirname, '../aerodrome_pools_full.json');
    console.log(`Successfully scanned ${allPools.length} pools.`);
    fs.writeFileSync(outputPath, JSON.stringify(allPools, null, 2));
    console.log(`Data saved to ${outputPath}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});