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
    this.bondingTokens = [];
    this.graduatedTokens = [];
    this.activeTab = 'bonding'; // Default to bonding tab
    this.sortColumn = 'total'; // Default sort by total score
    this.sortDirection = 'desc';
  }

  async init() {
    await this.updateTokens();
    await this.updateSolPrice();
    this.startAutoUpdate();
    this.updateConnectionStatus(true);
    this.setupSortHandlers();
    this.setupTabHandlers();
    this.setupSearchHandlers();
  }

  async updateTokens() {
    try {
      const url = `${this.apiUrl}/tokens?page=${this.currentPage}&limit=${this.tokensPerPage}`;
      console.log('Fetching tokens from:', url);
      const response = await fetch(url);
      const data = await response.json();
      console.log('API Response:', { success: data.success, tokenCount: data.tokens?.length, pagination: data.pagination });
      
      if (data.tokens && data.pagination) {
        this.allTokens = data.tokens;
        // For server-side pagination, we don't filter here
        this.bondingTokens = data.tokens;
        this.graduatedTokens = data.tokens;
        
        this.totalTokens = data.pagination.total;
        this.renderTokens();
        this.renderPagination(data.pagination);
      } else {
        console.error('Invalid API response structure:', data);
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

    // With server-side pagination, tokens are already paginated
    const tokenList = this.allTokens;

    tokenList.forEach((token, index) => {
      // Calculate actual rank based on page
      token.rank = ((this.currentPage - 1) * this.tokensPerPage) + index + 1;
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
        <td class="progress">${this.renderProgressBar(token.bondingCurveProgress, token.isGraduated)}</td>
        <td class="score ${this.getScoreClass(token.scores.total, 999)}">${Math.round(token.scores.total)}</td>
        <td class="score ${this.getScoreClass(token.scores.technical, 333)}" title="Market Cap: ${Math.round(token.scores.marketCap)}/100 | Bonding Curve: ${Math.round(token.scores.bondingCurve)}/83 | Trading Health: ${Math.round(token.scores.tradingHealth)}/75 | Sell-off Response: ${Math.round(token.scores.selloffResponse)}/75">${Math.round(token.scores.technical)}${token.isSelloffActive ? ' ⚠️' : ''}</td>
        <td class="score ${this.getScoreClass(token.scores.holder, 333)}" title="${this.getHolderScoreTooltip(token)}">${Math.round(token.scores.holder)}</td>
        <td class="score ${this.getScoreClass(token.scores.social, 333)}">${token.scores.social}</td>
        <td class="age">${token.age}</td>
        <td class="txns">${this.formatNumber(token.txns24h)}</td>
        <td class="holders">${this.formatNumber(token.holders)}</td>
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

  formatProgress(progress, isGraduated) {
    if (isGraduated) return 'Graduated';
    if (progress === null || progress === undefined) return 'N/A';
    return `${progress.toFixed(1)}%`;
  }

  getProgressColorClass(progress) {
    if (progress === null || progress === undefined) return 'no-progress';
    
    // Return a data attribute for dynamic color calculation
    return `progress-${Math.floor(progress / 10) * 10}`;
  }

  renderProgressBar(progress, isGraduated) {
    if (isGraduated) {
      return `
        <div class="progress-bar-container graduated">
          <div class="progress-bar-fill progress-graduated" style="width: 100%"></div>
          <span class="progress-text">🎓 Graduated</span>
        </div>
      `;
    }
    
    if (progress === null || progress === undefined) {
      return '<span class="no-progress">N/A</span>';
    }
    
    const progressClass = this.getProgressColorClass(progress);
    const progressText = this.formatProgress(progress, false);
    
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

  getHolderScoreTooltip(token) {
    // If no holder score data, return a default message
    if (!token.scores.holder || token.scores.holder === 0) {
      return 'No holder data available (requires 10-25% bonding curve progress)';
    }

    const parts = [];
    
    // Distribution score breakdown
    parts.push(`Distribution: ${Math.round(token.scores.holderDistribution)}/111`);
    
    // Quality score breakdown
    parts.push(`Quality: ${Math.round(token.scores.holderQuality)}/111`);
    
    // Activity score breakdown
    parts.push(`Activity: ${Math.round(token.scores.holderActivity)}/111`);
    
    // Add key metrics if available
    if (token.scores.uniqueHolders) {
      parts.push(`| ${token.scores.uniqueHolders} holders`);
    }
    
    if (token.scores.giniCoefficient !== null && token.scores.giniCoefficient !== undefined) {
      parts.push(`| Gini: ${token.scores.giniCoefficient.toFixed(3)}`);
    }
    
    if (token.scores.top10Concentration !== null && token.scores.top10Concentration !== undefined) {
      parts.push(`| Top 10: ${token.scores.top10Concentration.toFixed(1)}%`);
    }
    
    if (token.scores.botRatio !== null && token.scores.botRatio !== undefined) {
      const botPercentage = (token.scores.botRatio * 100).toFixed(1);
      if (token.scores.botRatio > 0.3) {
        parts.push(`| ⚠️ Bots: ${botPercentage}%`);
      } else {
        parts.push(`| Bots: ${botPercentage}%`);
      }
    }
    
    if (token.scores.avgWalletAge !== null && token.scores.avgWalletAge !== undefined) {
      parts.push(`| Avg age: ${Math.round(token.scores.avgWalletAge)}d`);
    }
    
    return parts.join(' ');
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

  renderPagination(paginationInfo) {
    const paginationContainer = document.querySelector('.pagination');
    if (!paginationContainer) {
      // Create pagination container if it doesn't exist
      const container = document.createElement('div');
      container.className = 'pagination';
      document.querySelector('.token-table').after(container);
    }
    
    const totalPages = paginationInfo ? paginationInfo.totalPages : Math.ceil(this.totalTokens / this.tokensPerPage);
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
    
    // Page info with prominent total display
    const pageInfo = document.createElement('span');
    pageInfo.className = 'page-info';
    const startItem = ((this.currentPage - 1) * this.tokensPerPage) + 1;
    const endItem = Math.min(this.currentPage * this.tokensPerPage, this.totalTokens);
    pageInfo.innerHTML = `
      <span style="font-size: 1.1em; font-weight: 600;">
        Showing ${startItem}-${endItem} of <span style="color: #00ff00;">${this.totalTokens}</span> tokens
      </span>
      <br>
      <span style="font-size: 0.9em; opacity: 0.8;">Page ${this.currentPage} of ${totalPages}</span>
    `;
    pagination.appendChild(pageInfo);
    
    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'pagination-btn';
    nextBtn.textContent = 'Next →';
    nextBtn.disabled = this.currentPage === totalPages;
    nextBtn.onclick = () => this.changePage(this.currentPage + 1);
    pagination.appendChild(nextBtn);
    
    // Last button
    const lastBtn = document.createElement('button');
    lastBtn.className = 'pagination-btn';
    lastBtn.textContent = 'Last ⇥';
    lastBtn.disabled = this.currentPage === totalPages;
    lastBtn.onclick = () => this.changePage(totalPages);
    pagination.appendChild(lastBtn);
  }
  
  async changePage(page) {
    const totalPages = Math.ceil(this.totalTokens / this.tokensPerPage);
    if (page < 1 || page > totalPages) return;
    
    this.currentPage = page;
    await this.updateTokens(); // Fetch new page from server
    
    // Scroll to top of table
    document.querySelector('.token-table').scrollIntoView({ behavior: 'smooth' });
  }

  startAutoUpdate() {
    setInterval(async () => {
      await this.updateTokens();
      await this.updateSolPrice();
    }, this.updateInterval);
  }
  
  setupSortHandlers() {
    // Add click handlers to sortable columns
    const headers = document.querySelectorAll('th');
    const sortableColumns = {
      4: 'total',      // Total score
      5: 'technical',  // Technical score
      6: 'holder',     // Holder score
      7: 'social'      // Social score
    };
    
    Object.entries(sortableColumns).forEach(([index, column]) => {
      const header = headers[parseInt(index)];
      if (header) {
        header.style.cursor = 'pointer';
        header.title = 'Click to sort';
        header.addEventListener('click', () => {
          this.sortBy(column);
          this.updateSortIndicators(parseInt(index));
        });
        
        // Add initial sort indicator for total score
        if (column === 'total') {
          header.innerHTML = header.textContent + ' ▼';
        }
      }
    });
  }
  
  updateSortIndicators(columnIndex) {
    // Remove all sort indicators
    const headers = document.querySelectorAll('th');
    headers.forEach(header => {
      header.innerHTML = header.textContent.replace(' ▲', '').replace(' ▼', '');
    });
    
    // Add indicator to current column
    const header = headers[columnIndex];
    if (header) {
      header.innerHTML = header.textContent + (this.sortDirection === 'desc' ? ' ▼' : ' ▲');
    }
  }
  
  sortBy(column) {
    // Toggle direction if same column
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'desc' ? 'asc' : 'desc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'desc';
    }
    
    // Sort all token lists
    const sortFunction = (a, b) => {
      let aVal = column === 'total' ? a.scores.total : a.scores[column];
      let bVal = column === 'total' ? b.scores.total : b.scores[column];
      
      if (this.sortDirection === 'desc') {
        return bVal - aVal;
      } else {
        return aVal - bVal;
      }
    };
    
    this.allTokens.sort(sortFunction);
    this.bondingTokens.sort(sortFunction);
    this.graduatedTokens.sort(sortFunction);
    
    // Re-render
    this.renderTokens();
  }
  
  setupTabHandlers() {
    const tabButtons = document.querySelectorAll('.tab-button');
    tabButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        // Remove active class from all buttons
        tabButtons.forEach(btn => btn.classList.remove('active'));
        // Add active class to clicked button
        e.target.classList.add('active');
        
        // Update active tab
        this.activeTab = e.target.dataset.tab;
        
        // Reset to first page when switching tabs
        this.currentPage = 1;
        
        // Update total tokens count for the active tab
        this.totalTokens = this.activeTab === 'bonding' ? this.bondingTokens.length : this.graduatedTokens.length;
        
        // Re-render tokens and pagination
        this.renderTokens();
        this.renderPagination();
      });
    });
  }

  setupSearchHandlers() {
    const searchInput = document.getElementById('tokenSearch');
    const searchButton = document.getElementById('searchButton');
    const clearButton = document.getElementById('clearSearchButton');

    // Search button click handler
    searchButton.addEventListener('click', () => {
      this.performSearch();
    });

    // Enter key in search input
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.performSearch();
      }
    });

    // Clear button click handler
    clearButton.addEventListener('click', () => {
      this.clearSearch();
    });
  }

  async performSearch() {
    const searchInput = document.getElementById('tokenSearch');
    const clearButton = document.getElementById('clearSearchButton');
    const mintAddress = searchInput.value.trim();

    if (!mintAddress) {
      this.showSearchMessage('Please enter a mint address', 'error');
      return;
    }

    try {
      const response = await fetch(`${this.apiUrl}/search/${mintAddress}`);
      const data = await response.json();

      if (data.success && data.token) {
        // Show only the searched token
        this.allTokens = [data.token];
        this.bondingTokens = data.token.isGraduated ? [] : [data.token];
        this.graduatedTokens = data.token.isGraduated ? [data.token] : [];
        
        // Update to the appropriate tab
        this.activeTab = data.token.isGraduated ? 'graduated' : 'bonding';
        
        // Update tab buttons
        document.querySelectorAll('.tab-button').forEach(btn => {
          btn.classList.remove('active');
          if (btn.dataset.tab === this.activeTab) {
            btn.classList.add('active');
          }
        });
        
        this.totalTokens = 1;
        this.currentPage = 1;
        this.renderTokens();
        this.renderPagination();
        
        // Show clear button
        clearButton.style.display = 'inline-block';
        this.showSearchMessage(`Found token: ${data.token.symbol}`, 'success');
      } else {
        this.showSearchMessage('Token not found', 'error');
      }
    } catch (error) {
      console.error('Search failed:', error);
      this.showSearchMessage('Search failed. Please try again.', 'error');
    }
  }

  clearSearch() {
    const searchInput = document.getElementById('tokenSearch');
    const clearButton = document.getElementById('clearSearchButton');
    
    searchInput.value = '';
    clearButton.style.display = 'none';
    this.removeSearchMessage();
    
    // Reload all tokens
    this.updateTokens();
  }

  showSearchMessage(message, type) {
    this.removeSearchMessage();
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `search-result-message ${type}`;
    messageDiv.textContent = message;
    
    const tabsContainer = document.querySelector('.tabs-container');
    tabsContainer.parentNode.insertBefore(messageDiv, tabsContainer.nextSibling);
    
    // Auto-remove message after 5 seconds
    setTimeout(() => {
      this.removeSearchMessage();
    }, 5000);
  }

  removeSearchMessage() {
    const existingMessage = document.querySelector('.search-result-message');
    if (existingMessage) {
      existingMessage.remove();
    }
  }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  const dashboard = new Dashboard();
  dashboard.init();
});