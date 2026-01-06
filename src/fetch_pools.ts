import { ethers, Contract } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// CONFIGURATION
const RPC_URL = 'http://127.0.0.1:8545'; 
// If local node fails, try public RPC to verify script logic: 'https://mainnet.base.org'
const AERODROME_FACTORY_ADDRESS = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BATCH_SIZE = 500;

// FIXED ABIS (Ethers v6 Compatible)
const FACTORY_ABI = [
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)'
];

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'
];

// Fixed Multicall ABI: Removed "struct" keyword, used tuple syntax directly
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
    
    // 1. DIAGNOSTICS: Check Node Sync Status
    try {
        const network = await provider.getNetwork();
        const blockNumber = await provider.getBlockNumber();
        console.log(`✅ Connected to: ${network.name} (Chain ID: ${network.chainId})`);
        console.log(`📦 Current Local Block Height: ${blockNumber}`);
        
        // Aerodrome was deployed around block 2,000,000+. 
        // If your block is low, the contract doesn't exist yet.
        if (blockNumber < 2000000) {
            console.error("\n[CRITICAL ERROR] Your local node is not fully synced yet!");
            console.error("The Aerodrome Factory contract does not exist at this block height.");
            console.error("Please wait for the node to sync closer to the chain tip (24M+).");
            process.exit(1);
        }
    } catch (error) {
        console.error("Failed to check node status:", error);
        process.exit(1);
    }

    const factory = new Contract(AERODROME_FACTORY_ADDRESS, FACTORY_ABI, provider);
    const multicall = new Contract(MULTICALL_ADDRESS, MULTICALL_ABI, provider);

    // 2. Get total number of pairs
    console.log("Fetching total pair count from Factory...");
    try {
        const totalPairsBigInt = await factory.allPairsLength();
        const totalPairs = Number(totalPairsBigInt);
        console.log(`Total Aerodrome Pools found: ${totalPairs}`);

        const allPools: PoolData[] = [];
        const pairInterface = new ethers.Interface(PAIR_ABI);

        // 3. Loop through in batches
        for (let i = 0; i < totalPairs; i += BATCH_SIZE) {
            const end = Math.min(i + BATCH_SIZE, totalPairs);
            console.log(`Processing batch: ${i} to ${end - 1}...`);

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
                
                const poolAddresses: string[] = returnDataAddresses.map((bytes: string) => 
                    factory.interface.decodeFunctionResult('allPairs', bytes)[0]
                );

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

                const [, returnDataDetails] = await multicall.aggregate(detailCalls);

                for (let k = 0; k < poolAddresses.length; k++) {
                    const baseIndex = k * 3;
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
                    } catch (e) { /* ignore decode errors */ }
                }

            } catch (err) {
                console.error(`Batch failed at index ${i}:`, err);
            }
        }

        const outputPath = path.join(__dirname, '../aerodrome_pools_full.json');
        console.log(`Successfully scanned ${allPools.length} pools.`);
        fs.writeFileSync(outputPath, JSON.stringify(allPools, null, 2));
        console.log(`Data saved to ${outputPath}`);

    } catch (err) {
        console.error("Error calling Factory Contract:", err);
        console.log("Tip: Try switching RPC_URL to 'https://mainnet.base.org' to test if the code works.");
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});