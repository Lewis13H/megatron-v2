import { Connection, PublicKey } from '@solana/web3.js';
import { parsePriceData } from '@pythnetwork/client';

// Pyth SOL/USD price feed on mainnet
const PYTH_SOL_USD_PRICE_FEED = new PublicKey('H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG');

async function debugPythPrice() {
    console.log('Testing Pyth price feed...\n');
    
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    
    try {
        // Fetch the account info
        console.log('Fetching account info for:', PYTH_SOL_USD_PRICE_FEED.toString());
        const accountInfo = await connection.getAccountInfo(PYTH_SOL_USD_PRICE_FEED);
        
        if (!accountInfo) {
            console.error('❌ Pyth price feed account not found');
            return;
        }
        
        console.log('✅ Account info received:');
        console.log('  - Owner:', accountInfo.owner.toString());
        console.log('  - Data length:', accountInfo.data.length);
        console.log('  - Lamports:', accountInfo.lamports);
        
        // Try to parse the price data
        console.log('\nParsing price data...');
        const priceData = parsePriceData(accountInfo.data);
        
        console.log('\n📊 Parsed price data:');
        console.log('  - Raw price:', priceData.price);
        console.log('  - Aggregate price:', priceData.aggregate?.price);
        console.log('  - EMA price:', priceData.emaPrice);
        console.log('  - Exponent:', priceData.exponent);
        console.log('  - Confidence:', priceData.confidence);
        console.log('  - Aggregate confidence:', priceData.aggregate?.confidence);
        console.log('  - EMA confidence:', priceData.emaConfidence);
        console.log('  - Status:', priceData.status);
        console.log('  - Timestamp:', priceData.timestamp);
        
        // Try different price sources
        const price = priceData.aggregate?.price || priceData.emaPrice || priceData.price;
        const confidence = priceData.aggregate?.confidence || priceData.emaConfidence || priceData.confidence;
        
        // Calculate the actual price
        if (price) {
            // Convert to number if it's a bigint
            const priceNum = typeof price === 'bigint' ? Number(price) : price;
            const confNum = typeof confidence === 'bigint' ? Number(confidence) : (confidence || 0);
            
            const actualPrice = Number(priceNum) * Math.pow(10, priceData.exponent);
            const actualConfidence = Number(confNum) * Math.pow(10, priceData.exponent);
            
            console.log('\n💰 Calculated SOL/USD price:');
            console.log(`  - Price: $${price}`);
            console.log(`  - Confidence: ±$${confidence || 0}`);
            console.log(`  - Timestamp: ${new Date(Number(priceData.timestamp) * 1000).toISOString()}`);
            console.log(`  - Age: ${Math.floor((Date.now() - Number(priceData.timestamp) * 1000) / 1000)} seconds ago`);
        } else {
            console.log('\n❌ No price available in the data');
            console.log('Full data structure:', JSON.stringify(priceData, (key, value) => 
                typeof value === 'bigint' ? value.toString() : value, 2));
        }
        
        // Show raw data sample
        console.log('\n🔍 Raw data sample (first 256 bytes):');
        console.log(accountInfo.data.slice(0, 256).toString('hex'));
        
    } catch (error) {
        console.error('\n❌ Error:', error);
        if (error instanceof Error) {
            console.error('Message:', error.message);
            console.error('Stack:', error.stack);
        }
    }
}

// Run the debug script
debugPythPrice().catch(console.error);