/**
 * Example: How to integrate the new SOL price service into monitors
 */

import { getSolPrice, getSolPriceWithDetails } from '../index';

// Example 1: Simple price fetch for calculations
export async function calculateTokenValueInUSD(tokenPriceInSol: number): Promise<number> {
  const solPrice = await getSolPrice();
  return tokenPriceInSol * solPrice;
}

// Example 2: Get price with confidence for detailed analytics
export async function getDetailedPriceInfo() {
  const priceData = await getSolPriceWithDetails();
  
  console.log(`SOL Price: $${priceData.price.toFixed(4)}`);
  console.log(`Source: ${priceData.source}`);
  console.log(`Updated: ${priceData.timestamp.toISOString()}`);
  
  if (priceData.confidence) {
    console.log(`Confidence: ${(priceData.confidence * 100).toFixed(2)}%`);
  }
}

// Example 3: Integration in transaction saving
export async function saveTransactionWithUSD(transaction: any) {
  try {
    // Get current SOL price
    const solPrice = await getSolPrice();
    
    // Calculate USD values
    const pricePerTokenUSD = transaction.pricePerToken * solPrice;
    const solAmountUSD = transaction.solAmount * solPrice;
    
    // Save to database with USD values
    const enrichedTransaction = {
      ...transaction,
      pricePerTokenUSD,
      solAmountUSD,
      solPriceAtTime: solPrice
    };
    
    // Your database save logic here
    console.log('Transaction saved with USD values:', enrichedTransaction);
    
  } catch (error) {
    console.error('Error calculating USD values:', error);
    // Save without USD values as fallback
  }
}

// Example 4: Batch processing with cached price
export async function processBatchTransactions(transactions: any[]) {
  // Get price once for the batch
  const solPrice = await getSolPrice();
  
  const enrichedTransactions = transactions.map(tx => ({
    ...tx,
    pricePerTokenUSD: tx.pricePerToken * solPrice,
    solAmountUSD: tx.solAmount * solPrice
  }));
  
  return enrichedTransactions;
}