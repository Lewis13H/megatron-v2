// Dashboard JavaScript for real-time data updates
class Dashboard {
  constructor() {
    this.apiUrl = 'http://localhost:3000/api'; // Update with your API URL
    this.updateInterval = 5000; // 5 seconds
    this.isConnected = false;
    this.currentPage = 1;
    this.tokensPerPage = 50;
    this.totalTokens = 0;
    this.allTokens = [];
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
        this.allTokens = data.tokens;
        this.totalTokens = data.tokens.length;
        this.renderTokens();
        this.renderPagination();
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

  renderTokens() {
    const tbody = document.querySelector('.token-table tbody');
    tbody.innerHTML = '';

    const startIndex = (this.currentPage - 1) * this.tokensPerPage;
    const endIndex = startIndex + this.tokensPerPage;
    const paginatedTokens = this.allTokens.slice(startIndex, endIndex);

    paginatedTokens.forEach(token => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="token-info">
          <span class="rank">#${token.rank}</span>
          <div class="chain-icons">
            <a href="https://dexscreener.com/solana/${token.address}" target="_blank" rel="noopener noreferrer" class="platform-link">
              ${token.platform === 'pumpfun' 
                ? '<img src="https://pump.fun/_next/image?url=%2Flogo.png&w=48&q=75" alt="Pump.fun" class="platform-icon" style="width: 20px; height: 20px;">'
                : token.platform === 'raydium_launchpad'
                ? '<img src="raydium-launchpad-icon.png" alt="Raydium Launchpad" class="platform-icon" style="width: 20px; height: 20px;">'
                : '<img src="raydium-launchpad-icon.png" alt="Unknown" class="platform-icon" style="width: 20px; height: 20px;">'
              }
            </a>
          </div>
          <img src="${this.getImageUrl(token.image)}" alt="Token" class="token-icon" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'32\\' height=\\'32\\' fill=\\'%23333\\'%3E%3Crect width=\\'32\\' height=\\'32\\' rx=\\'16\\'/%3E%3C/svg%3E'">
          <div class="token-details">
            <span class="token-name">${token.symbol}</span>
            <span class="token-symbol">${token.name}</span>
          </div>
        </td>
        <td class="price">
          <div class="usd-value">${this.formatPrice(token.price.usd)}</div>
          <div class="sol-value">${this.formatPriceWithoutDollar(token.price.sol)} SOL</div>
        </td>
        <td class="mcap">
          <div class="usd-value">${this.formatMarketCap(token.marketCap.usd)}</div>
          <div class="sol-value">${this.formatMarketCapSol(token.marketCap.sol)} SOL</div>
        </td>
        <td class="progress">${this.renderProgressBar(token.bondingCurveProgress)}</td>
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

  formatProgress(progress) {
    if (progress === null || progress === undefined) return 'N/A';
    return `${progress.toFixed(1)}%`;
  }

  getProgressColorClass(progress) {
    if (progress === null || progress === undefined) return 'no-progress';
    
    // Return a data attribute for dynamic color calculation
    return `progress-${Math.floor(progress / 10) * 10}`;
  }

  renderProgressBar(progress) {
    if (progress === null || progress === undefined) {
      return '<span class="no-progress">N/A</span>';
    }
    
    const progressClass = this.getProgressColorClass(progress);
    const progressText = this.formatProgress(progress);
    
    return `
      <div class="progress-bar-container">
        <div class="progress-bar-fill ${progressClass}" style="width: ${progress}%"></div>
        <span class="progress-text">${progressText}</span>
      </div>
    `;
  }

  formatPrice(price) {
    return '$' + this.formatPriceWithoutDollar(price);
  }

  formatPriceWithoutDollar(price) {
    // Convert to number if it's a string
    const num = typeof price === 'string' ? parseFloat(price) : price;
    
    if (isNaN(num) || num === null || num === undefined || num === 0) return '0';
    
    // For very small numbers, use subscript notation
    if (num < 0.01) {
      const str = num.toFixed(20); // Get enough decimal places
      const match = str.match(/^0\.0*[1-9]/); // Find the first non-zero digit
      
      if (match) {
        const zerosCount = match[0].length - 2 - 1; // Subtract "0." and the non-zero digit
        const significantPart = num.toFixed(zerosCount + 4).slice(2 + zerosCount); // Get 4 significant digits
        
        if (zerosCount > 0) {
          // Use subscript numbers for zero count
          const subscriptNumbers = '₀₁₂₃₄₅₆₇₈₉';
          const subscriptZeros = zerosCount.toString().split('').map(d => subscriptNumbers[parseInt(d)]).join('');
          return `0.${subscriptZeros}${significantPart}`;
        } else {
          return num.toFixed(4);
        }
      }
    }
    
    // For numbers >= 0.01
    if (num < 1) return num.toFixed(4);
    if (num < 10) return num.toFixed(3);
    if (num < 100) return num.toFixed(2);
    return num.toFixed(2);
  }

  formatMarketCap(value) {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num) || num === null || num === undefined) return '$0';
    
    if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
    if (num >= 1e3) return `$${(num / 1e3).toFixed(3)}K`;
    return `$${num.toFixed(0)}`;
  }

  formatMarketCapSol(value) {
    const num = typeof value === 'string' ? parseFloat(value) : value;
    if (isNaN(num) || num === null || num === undefined) return '0.00';
    
    if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
    if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
    if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
    return num.toFixed(2);
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

  renderPagination() {
    const paginationContainer = document.querySelector('.pagination');
    if (!paginationContainer) {
      // Create pagination container if it doesn't exist
      const container = document.createElement('div');
      container.className = 'pagination';
      document.querySelector('.token-table').after(container);
    }
    
    const totalPages = Math.ceil(this.totalTokens / this.tokensPerPage);
    const pagination = document.querySelector('.pagination');
    pagination.innerHTML = '';
    
    // First button
    const firstBtn = document.createElement('button');
    firstBtn.className = 'pagination-btn';
    firstBtn.textContent = '⇤ First';
    firstBtn.disabled = this.currentPage === 1;
    firstBtn.onclick = () => this.changePage(1);
    pagination.appendChild(firstBtn);
    
    // Previous button
    const prevBtn = document.createElement('button');
    prevBtn.className = 'pagination-btn';
    prevBtn.textContent = '← Previous';
    prevBtn.disabled = this.currentPage === 1;
    prevBtn.onclick = () => this.changePage(this.currentPage - 1);
    pagination.appendChild(prevBtn);
    
    // Page info
    const pageInfo = document.createElement('span');
    pageInfo.className = 'page-info';
    pageInfo.textContent = `Page ${this.currentPage} of ${totalPages} (${this.totalTokens} tokens)`;
    pagination.appendChild(pageInfo);
    
    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pagination-btn';
    nextBtn.textContent = 'Next →';
    nextBtn.disabled = this.currentPage === totalPages;
    nextBtn.onclick = () => this.changePage(this.currentPage + 1);
    pagination.appendChild(nextBtn);
  }
  
  changePage(page) {
    const totalPages = Math.ceil(this.totalTokens / this.tokensPerPage);
    if (page < 1 || page > totalPages) return;
    
    this.currentPage = page;
    this.renderTokens();
    this.renderPagination();
    
    // Scroll to top of table
    document.querySelector('.token-table').scrollIntoView({ behavior: 'smooth' });
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