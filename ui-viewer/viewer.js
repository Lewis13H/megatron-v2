let tokensData = [];
let poolsData = [];
let transactionsData = [];
let lastUpdate = null;

async function loadAllData() {
    try {
        const [tokens, pools, transactions] = await Promise.all([
            loadJSON('data/tokens.json'),
            loadJSON('data/pools.json'),
            loadJSON('data/transactions.json')
        ]);

        tokensData = tokens.data || [];
        poolsData = pools.data || [];
        transactionsData = transactions.data || [];
        lastUpdate = tokens.exportTime || new Date().toISOString();

        document.getElementById('last-update').textContent = `Last Update: ${formatDate(lastUpdate)}`;
        
        renderTokens();
        renderPools();
        renderTransactions();
        renderSummary();
    } catch (error) {
        console.error('Error loading data:', error);
        showError('Failed to load data. Make sure to run the export script first.');
    }
}

async function loadJSON(path) {
    try {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error(`Error loading ${path}:`, error);
        return { data: [], exportTime: new Date().toISOString() };
    }
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString();
}

function formatAddress(address) {
    if (!address) return '';
    return address.slice(0, 4) + '...' + address.slice(-4);
}

function formatNumber(num) {
    if (!num) return '0';
    return new Intl.NumberFormat().format(num);
}

function formatSOL(lamports) {
    if (!lamports) return '0';
    const sol = lamports / 1e9;
    return sol.toFixed(4);
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    event.target.classList.add('active');
    document.getElementById(`${tabName}-tab`).classList.add('active');
}

function renderTokens() {
    const grid = document.getElementById('tokens-grid');
    const count = document.getElementById('token-count');
    
    if (tokensData.length === 0) {
        grid.innerHTML = '<div class="loading">No tokens found</div>';
        count.textContent = '0';
        return;
    }

    count.textContent = tokensData.length;
    
    let html = `
        <table>
            <thead>
                <tr>
                    <th>Symbol</th>
                    <th>Name</th>
                    <th>Platform</th>
                    <th>Market Cap (SOL)</th>
                    <th>Price (SOL)</th>
                    <th>BC Progress</th>
                    <th>Created</th>
                    <th>Address</th>
                </tr>
            </thead>
            <tbody>
    `;

    tokensData.forEach((token, index) => {
        // Find the pool for this token to get price and bonding curve data
        const pool = poolsData.find(p => p.tokenAddress === token.address);
        let pricePerSol = 'N/A';
        let bcProgress = 'N/A';
        let marketCapSol = 'N/A';
        
        // Debug first few tokens to verify market cap calculation
        if (index < 3 && pool) {
            console.log(`Debug token ${index + 1} (${token.symbol}):`, {
                platform: token.platform,
                virtualSolReserves: pool.virtualSolReserves,
                virtualTokenReserves: pool.virtualTokenReserves,
                bondingCurveProgress: pool.bondingCurveProgress,
                totalSupply: token.totalSupply,
                calculatedMarketCap: 'See below after calculation'
            });
        }
        
        if (pool) {
            // Use the latest price from database if available
            let pricePerToken;
            if (pool.latestPrice) {
                // Use the authoritative price from the database
                pricePerToken = parseFloat(pool.latestPrice);
                
                // Format price with appropriate decimals
                if (pricePerToken < 0.000001) {
                    pricePerSol = pricePerToken.toExponential(4);
                } else if (pricePerToken < 0.01) {
                    pricePerSol = pricePerToken.toFixed(9);
                } else {
                    pricePerSol = pricePerToken.toFixed(6);
                }
            } else if (pool.virtualSolReserves && pool.virtualTokenReserves) {
                // Fallback: Calculate price from reserves if latestPrice not available
                const solReserves = parseFloat(pool.virtualSolReserves);
                const tokenReserves = parseFloat(pool.virtualTokenReserves);
                
                // Price per token = SOL reserves / token reserves
                pricePerToken = (solReserves / 1e9) / (tokenReserves / 1e6);
                
                // Format price with appropriate decimals
                if (pricePerToken < 0.000001) {
                    pricePerSol = pricePerToken.toExponential(4);
                } else if (pricePerToken < 0.01) {
                    pricePerSol = pricePerToken.toFixed(9);
                } else {
                    pricePerSol = pricePerToken.toFixed(6);
                }
            }
                
            // Calculate market cap in SOL
            let marketCap;
            
            if (pricePerToken && token.platform === 'pumpfun') {
                // For Pump.fun tokens, market cap = total supply × price
                // Total supply is 1 trillion tokens (1e15 raw / 1e6 decimals = 1e9 tokens)
                const TOTAL_SUPPLY = 1e9; // 1 billion tokens (1 trillion with 6 decimals)
                
                // Market cap = total supply × price per token
                marketCap = TOTAL_SUPPLY * pricePerToken;
                
                // Add debug info for Pump.fun tokens
                if (index < 3) {
                    console.log(`Pump.fun market cap details for ${token.symbol}:`, {
                        totalSupply: TOTAL_SUPPLY,
                        pricePerToken: pricePerToken,
                        calculatedMarketCap: marketCap
                    });
                }
                
            } else if (pricePerToken) {
                // For other platforms, use traditional calculation
                const totalSupply = token.totalSupply ? parseFloat(token.totalSupply) : 1e9;
                marketCap = totalSupply * pricePerToken;
            }
                
            // Format market cap with appropriate decimals
            if (marketCap !== undefined) {
                if (marketCap < 1) {
                    marketCapSol = marketCap.toFixed(4);
                } else if (marketCap < 100) {
                    marketCapSol = marketCap.toFixed(2);
                } else {
                    marketCapSol = marketCap.toFixed(0);
                }
            }
            
            // Debug log moved inside platform-specific blocks above
            
            // Get bonding curve progress if available
            if (pool.bondingCurveProgress !== null && pool.bondingCurveProgress !== undefined) {
                bcProgress = `${parseFloat(pool.bondingCurveProgress).toFixed(2)}%`;
            }
        }
        
        html += `
            <tr>
                <td><span class="symbol">${token.symbol || 'N/A'}</span></td>
                <td>${token.name || 'N/A'}</td>
                <td><span class="platform ${token.platform}">${token.platform}</span></td>
                <td class="amount">${marketCapSol}</td>
                <td class="amount">${pricePerSol}</td>
                <td class="amount">${bcProgress}</td>
                <td>${formatDate(token.createdAt)}</td>
                <td><span class="address clickable" onclick="copyToClipboard('${token.address}')">${formatAddress(token.address)}</span></td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    grid.innerHTML = html;
}

function renderPools() {
    const grid = document.getElementById('pools-grid');
    const count = document.getElementById('pool-count');
    
    if (poolsData.length === 0) {
        grid.innerHTML = '<div class="loading">No pools found</div>';
        count.textContent = '0';
        return;
    }

    count.textContent = poolsData.length;
    
    let html = `
        <table>
            <thead>
                <tr>
                    <th>Pool Address</th>
                    <th>Token</th>
                    <th>Platform</th>
                    <th>Price (SOL)</th>
                    <th>Token Reserve</th>
                    <th>SOL Reserve</th>
                    <th>Last Updated</th>
                </tr>
            </thead>
            <tbody>
    `;

    poolsData.forEach(pool => {
        const token = tokensData.find(t => t.address === pool.tokenAddress);
        
        // Format price
        let priceDisplay = 'N/A';
        if (pool.latestPrice) {
            const price = parseFloat(pool.latestPrice);
            if (price < 0.000001) {
                priceDisplay = price.toExponential(4);
            } else if (price < 0.01) {
                priceDisplay = price.toFixed(9);
            } else {
                priceDisplay = price.toFixed(6);
            }
        }
        
        html += `
            <tr>
                <td><span class="address clickable" onclick="copyToClipboard('${pool.address}')">${formatAddress(pool.address)}</span></td>
                <td><span class="symbol">${token?.symbol || 'Unknown'}</span></td>
                <td><span class="platform ${pool.platform}">${pool.platform}</span></td>
                <td class="amount">${priceDisplay}</td>
                <td class="amount">${formatNumber(pool.virtualTokenReserves)}</td>
                <td class="amount">${formatSOL(pool.virtualSolReserves)} SOL</td>
                <td>${formatDate(pool.updatedAt || pool.createdAt)}</td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    grid.innerHTML = html;
}

function renderTransactions() {
    const grid = document.getElementById('transactions-grid');
    const count = document.getElementById('tx-count');
    
    if (transactionsData.length === 0) {
        grid.innerHTML = '<div class="loading">No transactions found</div>';
        count.textContent = '0';
        return;
    }

    count.textContent = transactionsData.length;
    
    let html = `
        <table>
            <thead>
                <tr>
                    <th>Time</th>
                    <th>Type</th>
                    <th>Token</th>
                    <th>Amount</th>
                    <th>SOL</th>
                    <th>Signature</th>
                </tr>
            </thead>
            <tbody>
    `;

    transactionsData.slice(0, 100).forEach(tx => {
        const pool = poolsData.find(p => p.address === tx.poolAddress);
        const token = tokensData.find(t => t.address === pool?.tokenAddress);
        html += `
            <tr>
                <td>${formatDate(tx.timestamp)}</td>
                <td><span class="type ${tx.type}">${tx.type}</span></td>
                <td><span class="symbol">${token?.symbol || 'Unknown'}</span></td>
                <td class="amount">${formatNumber(tx.tokenAmount)}</td>
                <td class="amount">${formatSOL(tx.solAmount)} SOL</td>
                <td><span class="address clickable" onclick="copyToClipboard('${tx.signature}')">${formatAddress(tx.signature)}</span></td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    grid.innerHTML = html;
}

function renderSummary() {
    const tokenStats = document.getElementById('token-stats');
    const poolStats = document.getElementById('pool-stats');
    const txStats = document.getElementById('tx-stats');
    const recentActivity = document.getElementById('recent-activity');

    const pumpfunTokens = tokensData.filter(t => t.platform === 'pumpfun').length;
    const raydiumTokens = tokensData.filter(t => t.platform === 'raydium').length;

    tokenStats.innerHTML = `
        <div class="stat-item">
            <span class="stat-label">Total Tokens</span>
            <span class="stat-value">${formatNumber(tokensData.length)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Pump.fun Tokens</span>
            <span class="stat-value">${formatNumber(pumpfunTokens)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Raydium Tokens</span>
            <span class="stat-value">${formatNumber(raydiumTokens)}</span>
        </div>
    `;

    const pumpfunPools = poolsData.filter(p => p.platform === 'pumpfun').length;
    const raydiumPools = poolsData.filter(p => p.platform === 'raydium').length;

    poolStats.innerHTML = `
        <div class="stat-item">
            <span class="stat-label">Total Pools</span>
            <span class="stat-value">${formatNumber(poolsData.length)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Pump.fun Pools</span>
            <span class="stat-value">${formatNumber(pumpfunPools)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Raydium Pools</span>
            <span class="stat-value">${formatNumber(raydiumPools)}</span>
        </div>
    `;

    const buys = transactionsData.filter(t => t.type === 'buy').length;
    const sells = transactionsData.filter(t => t.type === 'sell').length;

    txStats.innerHTML = `
        <div class="stat-item">
            <span class="stat-label">Total Transactions</span>
            <span class="stat-value">${formatNumber(transactionsData.length)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Buy Orders</span>
            <span class="stat-value">${formatNumber(buys)}</span>
        </div>
        <div class="stat-item">
            <span class="stat-label">Sell Orders</span>
            <span class="stat-value">${formatNumber(sells)}</span>
        </div>
    `;

    const recentTokens = tokensData.slice(0, 5);
    let recentHtml = '<div style="font-size: 14px;">';
    recentTokens.forEach(token => {
        recentHtml += `<div style="margin-bottom: 8px;">New token: <span class="symbol">${token.symbol}</span> on ${token.platform}</div>`;
    });
    recentHtml += '</div>';
    recentActivity.innerHTML = recentHtml;
}

function filterTokens() {
    const filterText = document.getElementById('token-filter').value.toLowerCase();
    const platformFilter = document.getElementById('platform-filter').value;
    
    const filtered = tokensData.filter(token => {
        const matchesText = !filterText || 
            token.name?.toLowerCase().includes(filterText) ||
            token.symbol?.toLowerCase().includes(filterText) ||
            token.address?.toLowerCase().includes(filterText);
        
        const matchesPlatform = !platformFilter || token.platform === platformFilter;
        
        return matchesText && matchesPlatform;
    });

    renderFilteredTokens(filtered);
}

function filterPools() {
    const filterText = document.getElementById('pool-filter').value.toLowerCase();
    
    const filtered = poolsData.filter(pool => {
        return !filterText || 
            pool.address?.toLowerCase().includes(filterText) ||
            pool.tokenAddress?.toLowerCase().includes(filterText);
    });

    renderFilteredPools(filtered);
}

function filterTransactions() {
    const filterText = document.getElementById('tx-filter').value.toLowerCase();
    const typeFilter = document.getElementById('tx-type-filter').value;
    
    const filtered = transactionsData.filter(tx => {
        const matchesText = !filterText || 
            tx.signature?.toLowerCase().includes(filterText) ||
            tx.poolAddress?.toLowerCase().includes(filterText);
        
        const matchesType = !typeFilter || tx.type === typeFilter;
        
        return matchesText && matchesType;
    });

    renderFilteredTransactions(filtered);
}

function renderFilteredTokens(filtered) {
    tokensData = filtered;
    renderTokens();
}

function renderFilteredPools(filtered) {
    poolsData = filtered;
    renderPools();
}

function renderFilteredTransactions(filtered) {
    transactionsData = filtered;
    renderTransactions();
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showNotification('Copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy:', err);
    });
}

function showNotification(message) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background-color: #4a9eff;
        color: white;
        padding: 12px 20px;
        border-radius: 4px;
        font-size: 14px;
        z-index: 1000;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.remove();
    }, 2000);
}

function showError(message) {
    const grids = ['tokens-grid', 'pools-grid', 'transactions-grid'];
    grids.forEach(gridId => {
        document.getElementById(gridId).innerHTML = `<div class="loading" style="color: #ff4a4a;">${message}</div>`;
    });
}

// Auto-refresh every 30 seconds
setInterval(loadAllData, 30000);

// Load data on page load
window.onload = loadAllData;