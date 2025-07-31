// Dashboard JavaScript for real-time data updates
class Dashboard {
  constructor() {
    this.apiUrl = 'http://localhost:3000/api'; // Update with your API URL
    this.updateInterval = 5000; // 5 seconds
    this.isConnected = false;
  }

  async init() {
    await this.updateTokens();
    await this.updateSolPrice();
    this.startAutoUpdate();
    this.updateConnectionStatus(true);
  }

  async updateTokens() {
    try {
      const response = await fetch(`${this.apiUrl}/tokens`);
      const data = await response.json();
      
      if (data.tokens) {
        this.renderTokens(data.tokens);
      }
    } catch (error) {
      console.error('Failed to fetch tokens:', error);
      this.updateConnectionStatus(false);
    }
  }

  async updateSolPrice() {
    try {
      const response = await fetch(`${this.apiUrl}/sol-price`);
      const data = await response.json();
      
      const price = typeof data.price === 'string' ? parseFloat(data.price) : data.price;
      document.querySelector('.sol-price-value').textContent = `$${price.toFixed(2)}`;
      document.querySelector('.sol-price-updated').textContent = `Updated: ${data.secondsAgo}s ago`;
    } catch (error) {
      console.error('Failed to fetch SOL price:', error);
    }
  }

  renderTokens(tokens) {
    const tbody = document.querySelector('.token-table tbody');
    tbody.innerHTML = '';

    tokens.forEach(token => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="token-info">
          <span class="rank">#${token.rank}</span>
          <div class="chain-icons">
            <span class="chain-icon solana">⚡</span>
            <span class="chain-icon ${token.platform === 'pumpfun' ? 'pump' : 'raydium'}">
              ${token.platform === 'pumpfun' ? '🎯' : '🌊'}
            </span>
          </div>
          <img src="${this.getImageUrl(token.image)}" alt="Token" class="token-icon" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'32\\' height=\\'32\\' fill=\\'%23333\\'%3E%3Crect width=\\'32\\' height=\\'32\\' rx=\\'16\\'/%3E%3C/svg%3E'">
          <div class="token-details">
            <span class="token-name">${token.symbol}</span>
            <span class="token-symbol">${token.name}</span>
          </div>
        </td>
        <td class="price">
          <div class="usd-value">$${this.formatPrice(token.price.usd)}</div>
          <div class="sol-value">${this.formatPrice(token.price.sol)} SOL</div>
        </td>
        <td class="mcap">
          <div class="usd-value">${this.formatMarketCap(token.marketCap.usd)}</div>
          <div class="sol-value">${this.formatNumber(token.marketCap.sol)} SOL</div>
        </td>
        <td class="score ${this.getScoreClass(token.scores.total, 999)}">${token.scores.total}</td>
        <td class="score ${this.getScoreClass(token.scores.technical, 333)}">${token.scores.technical}</td>
        <td class="score ${this.getScoreClass(token.scores.holder, 333)}">${token.scores.holder}</td>
        <td class="score ${this.getScoreClass(token.scores.social, 333)}">${token.scores.social}</td>
        <td class="age">${token.age}</td>
        <td class="txns">${this.formatNumber(token.txns24h)}</td>
        <td class="volume">${this.formatMarketCap(token.volume24h.usd)}</td>
        <td class="makers">${this.formatNumber(token.makers24h)}</td>
        <td class="liquidity">${this.formatMarketCap(token.liquidity.usd)}</td>
      `;
      tbody.appendChild(row);
    });
  }

  getScoreClass(score, max) {
    const percentage = (score / max) * 100;
    if (percentage >= 75) return 'high';
    if (percentage >= 50) return 'medium';
    return 'low';
  }

  formatPrice(price) {
    // Convert to number if it's a string
    const num = typeof price === 'string' ? parseFloat(price) : price;
    
    if (isNaN(num) || num === null || num === undefined) return '0';
    
    if (num < 0.00001) return num.toExponential(2);
    if (num < 0.01) return num.toFixed(6);
    if (num < 1) return num.toFixed(4);
    return num.toFixed(2);
  }

  formatMarketCap(value) {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num) || num === null || num === undefined) return '$0';
    
    if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(1)}K`;
    return `$${num.toFixed(0)}`;
  }

  formatNumber(num) {
    const val = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(val) || val === null || val === undefined) return '0';
    
    if (val >= 1e6) return `${(val / 1e6).toFixed(1)}M`;
    if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`;
    return Math.floor(val).toLocaleString();
  }

  getImageUrl(imageUri) {
    if (!imageUri) {
      return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="%23333"%3E%3Crect width="32" height="32" rx="16"/%3E%3C/svg%3E';
    }
    
    // Handle IPFS URLs - use a public gateway
    if (imageUri.startsWith('ipfs://')) {
      return imageUri.replace('ipfs://', 'https://gateway.pinata.cloud/ipfs/');
    }
    
    // Handle direct IPFS URLs
    if (imageUri.includes('ipfs.io')) {
      return imageUri.replace('https://ipfs.io/', 'https://gateway.pinata.cloud/');
    }
    
    // Return as-is for other URLs
    return imageUri;
  }

  updateConnectionStatus(connected) {
    this.isConnected = connected;
    const statusDot = document.querySelector('.status-dot');
    const statusText = document.querySelector('.status-text');
    
    if (connected) {
      statusDot.classList.add('active');
      statusDot.classList.remove('inactive');
      statusText.textContent = 'Connected';
    } else {
      statusDot.classList.remove('active');
      statusDot.classList.add('inactive');
      statusText.textContent = 'Disconnected';
    }
  }

  startAutoUpdate() {
    setInterval(async () => {
      await this.updateTokens();
      await this.updateSolPrice();
    }, this.updateInterval);
  }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  const dashboard = new Dashboard();
  dashboard.init();
});