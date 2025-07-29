Bonding Curve Progress Formula
Formula: BondingCurveProgress = 100 - ((leftTokens * 100) / initialRealTokenReserves)
Where:

leftTokens = realTokenReserves - reservedTokens

initialRealTokenReserves = totalSupply - reservedTokens

Definitions:

initialRealTokenReserves = totalSupply - reservedTokens
totalSupply: 1,000,000,000 (Pump Fun Token)
reservedTokens: 206,900,000
Therefore, initialRealTokenReserves: 793,100,000
leftTokens = realTokenReserves - reservedTokens
realTokenReserves: Token balance at the market address.
note
Simplified Formula: BondingCurveProgress = 100 - (((balance - 206900000) * 100) / 793100000)