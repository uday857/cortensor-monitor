const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');

// ======================
// CONFIGURATION
// ======================
const TELEGRAM_BOT_TOKEN = "YOUR_TELEGRAM_BOT_TOKEN";
const TELEGRAM_CHAT_ID = "YOUR_CHAT_ID";
const DASHBOARD_URL = 'https://dashboard-devnet4.cortensor.network/stats/heatmap/rank/table';
const DASHBOARD_NODE_URL = 'https://dashboard-devnet4.cortensor.network/stats/node/';
const ARBISCAN_URL = 'https://sepolia.arbiscan.io/address/';
const HISTORY_FILE = 'node_history.json';
const FULL_REPORT_INTERVAL = 120 * 60 * 1000;      // 2 hours
const HOURLY_CHECK_INTERVAL = 60 * 60 * 1000;      // 1 hour
const ACTIVITY_CHECK_INTERVAL = 10 * 60 * 1000;    // 10 minutes
const INACTIVITY_THRESHOLD = 10 * 60 * 1000;       // 10 minutes
const SCORE_DROP_THRESHOLD = 1;                   // 1%
const RANK_DROP_THRESHOLD = 3;                    // 3 positions
const MAX_MESSAGE_LENGTH = 4000;
const HISTORY_ENTRIES_TO_SHOW = 3;

// Your nodes to track
const MY_NODES = {
    "0xYourNodeAddress1": "server name or ip-docker container name",
    "0xYourNodeAddress2": "server name or ip-docker container name",
    "0xYourNodeAddress3": "server name or ip-docker container name"   
};

// Performance categories
const PERFORMANCE_CATEGORIES = [
  { name: 'Elite', minScore: 95, emoji: '🏆', color: '#27ae60' },
  { name: 'Excellent', minScore: 85, emoji: '⭐', color: '#2ecc71' },
  { name: 'Very Good', minScore: 75, emoji: '👍', color: '#3498db' },
  { name: 'Good', minScore: 60, emoji: '✅', color: '#f1c40f' },
  { name: 'Fair', minScore: 40, emoji: '⚠️', color: '#e67e22' },
  { name: 'Poor', minScore: 20, emoji: '❌', color: '#e74c3c' }
];

class NodeMonitor {
  constructor() {
    this.history = this.initializeHistory();
    this.validateConfig();
    this.lastReportTime = null;
  }

  initializeHistory() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        const data = fs.readFileSync(HISTORY_FILE, 'utf8');
        const parsed = JSON.parse(data) || {};
        
        Object.values(MY_NODES).forEach(name => {
          if (!parsed[name]) {
            parsed[name] = { 
              rankHistory: [], 
              precommitHistory: [],
              lastCategory: null,
              lastRankGroup: null,
              lastScore: null,
              lastRank: null,
              lastPrecommitCounter: null,
              lastCommitCounter: null,
              lastCounterCheckTime: null
            };
          } else {
            parsed[name].rankHistory = (parsed[name].rankHistory || []).slice(-HISTORY_ENTRIES_TO_SHOW);
            parsed[name].precommitHistory = (parsed[name].precommitHistory || []).slice(-HISTORY_ENTRIES_TO_SHOW);
            parsed[name].lastCategory = parsed[name].lastCategory || null;
            parsed[name].lastRankGroup = parsed[name].lastRankGroup || null;
            parsed[name].lastScore = parsed[name].lastScore || null;
            parsed[name].lastRank = parsed[name].lastRank || null;
            parsed[name].lastPrecommitCounter = parsed[name].lastPrecommitCounter || null;
            parsed[name].lastCommitCounter = parsed[name].lastCommitCounter || null;
            parsed[name].lastCounterCheckTime = parsed[name].lastCounterCheckTime || null;
          }
        });
        return parsed;
      }
    } catch (e) {
      console.error('Error loading history:', e.message);
    }
    
    const freshHistory = {};
    Object.values(MY_NODES).forEach(name => {
      freshHistory[name] = { 
        rankHistory: [], 
        precommitHistory: [],
        lastCategory: null,
        lastRankGroup: null,
        lastScore: null,
        lastRank: null,
        lastPrecommitCounter: null,
        lastCommitCounter: null,
        lastCounterCheckTime: null
      };
    });
    return freshHistory;
  }

  validateConfig() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.error("ERROR: Telegram credentials not configured!");
      process.exit(1);
    }
  }

  async sendTelegramMessage(message, isUrgent = false) {
    try {
      if (message.length > MAX_MESSAGE_LENGTH) {
        const parts = [];
        let start = 0;
        
        while (start < message.length) {
          let end = start + MAX_MESSAGE_LENGTH;
          const lastNewline = message.lastIndexOf('\n\n', end);
          if (lastNewline > start + (MAX_MESSAGE_LENGTH * 0.8)) {
            end = lastNewline;
          }
          parts.push(message.substring(start, end));
          start = end;
        }

        for (let i = 0; i < parts.length; i++) {
          const part = `${isUrgent ? '🚨 URGENT: ' : ''}[Part ${i+1}/${parts.length}]\n${parts[i]}`;
          await this._sendSingleMessage(part);
          if (i < parts.length - 1) await new Promise(r => setTimeout(r, 500));
        }
        return true;
      }
      
      return await this._sendSingleMessage((isUrgent ? '🚨 URGENT: ' : '') + message);
    } catch (error) {
      console.error('Telegram send failed:', error.message);
      return false;
    }
  }

  async _sendSingleMessage(message) {
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        },
        { timeout: 5000 }
      );
      return response.data.ok === true;
    } catch (error) {
      console.error('Telegram send failed:', error.message);
      return false;
    }
  }

  getAddressVariations(address) {
    return [
      address,
      address.toLowerCase(),
      `${address.slice(0, 6)}...${address.slice(-4)}`,
      `${address.slice(0, 4)}...${address.slice(-4)}`
    ];
  }

  cleanScore(score) {
    if (typeof score === 'string') {
      return parseFloat(score.replace(/%/g, ''));
    }
    return parseFloat(score) || 0;
  }

  getPerformanceCategory(score) {
    const numericScore = this.cleanScore(score);
    return PERFORMANCE_CATEGORIES.find(cat => numericScore >= cat.minScore) || 
           { name: 'Critical', emoji: '❌', color: '#ff0000' };
  }

  getRankGroup(rank) {
    if (rank <= 50) return 'Top 50';
    if (rank <= 100) return '51-100';
    if (rank <= 150) return '101-150';
    return 'Above 150';
  }

  parseLastActiveTime(lastActiveText) {
    if (!lastActiveText) return null;
    const matches = lastActiveText.match(/(\d+)\s*(minute|hour|day)s?/i);
    if (!matches) return null;

    const value = parseInt(matches[1]);
    const unit = matches[2].toLowerCase();
    const now = new Date();

    switch(unit) {
      case 'minute': return new Date(now - value * 60 * 1000);
      case 'hour': return new Date(now - value * 60 * 60 * 1000);
      case 'day': return new Date(now - value * 24 * 60 * 60 * 1000);
      default: return null;
    }
  }

  async fetchNodeData() {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      
      const page = await browser.newPage();
      await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle2', timeout: 90000 });
      await page.waitForSelector('table tbody tr', { timeout: 30000 });

      const allNodes = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        return rows.map(row => {
          const cells = row.querySelectorAll('td');
          return {
            address: cells[0]?.innerText.trim(),
            score: cells[1]?.innerText.trim(),
            lastActive: cells[3]?.innerText.trim(),
            rank: rows.indexOf(row) + 1,
            precommit: cells[4]?.innerText.trim(),
            precommitCounter: cells[5]?.innerText.trim(),
            commitCounter: cells[7]?.innerText.trim()
          };
        });
      });

      return allNodes;
    } catch (error) {
      console.error('Failed to fetch node data:', error);
      return null;
    } finally {
      if (browser) await browser.close();
    }
  }

  async checkNodeActivity() {
    const allNodes = await this.fetchNodeData();
    if (!allNodes) return;

    const inactiveNodes = [];
    const performanceSummary = {};
    
    Object.entries(MY_NODES).forEach(([fullAddress, name]) => {
      const variations = this.getAddressVariations(fullAddress);
      const foundNode = allNodes.find(node => 
        variations.some(variant => node.address.includes(variant))
      );
      
      if (foundNode) {
        const category = this.getPerformanceCategory(foundNode.score).name;
        performanceSummary[category] = (performanceSummary[category] || 0) + 1;

        const lastActiveTime = this.parseLastActiveTime(foundNode.lastActive);
        
        if (lastActiveTime && (new Date() - lastActiveTime) > INACTIVITY_THRESHOLD) {
          inactiveNodes.push({
            name,
            address: foundNode.address,
            fullAddress,
            lastActive: foundNode.lastActive,
            rank: foundNode.rank,
            score: foundNode.score,
            history: [...(this.history[name]?.rankHistory || [])]
          });
        }
        
        if (!this.history[name]) {
          this.history[name] = { 
            rankHistory: [], 
            precommitHistory: [],
            lastCategory: null,
            lastRankGroup: null,
            lastScore: null,
            lastRank: null,
            lastPrecommitCounter: null,
            lastCommitCounter: null,
            lastCounterCheckTime: null
          };
        }
      }
    });

    this.saveHistory();

    if (inactiveNodes.length > 0) {
      let summaryText = '<b>📊 Current Performance Summary</b>\n';
      PERFORMANCE_CATEGORIES.forEach(cat => {
        if (performanceSummary[cat.name]) {
          summaryText += `${cat.emoji} ${cat.name}: ${performanceSummary[cat.name]} node(s)\n`;
        }
      });
      
      const message = `<b>⚠️ Inactive Nodes Detected</b>\n\n${summaryText}\n\n` + 
        inactiveNodes.map(node => 
          `🚨 <b>${node.name}</b>\n` +
          `🆔 <code>${node.address}</code>\n` +
          `📊 Rank: ${node.rank}\n` +
          `⭐ Score: ${node.score || 'N/A'}%\n` +
          `⏱ Last Active: ${node.lastActive}\n` +
          `🔗 <a href="${DASHBOARD_NODE_URL}${node.fullAddress}">Dashboard</a> | ` +
          `<a href="${ARBISCAN_URL}${node.fullAddress}">Arbiscan</a>`
        ).join('\n\n');
      
      await this.sendTelegramMessage(message, true);
    }
  }

  async hourlyChecks() {
    const allNodes = await this.fetchNodeData();
    if (!allNodes) return;

    const alerts = {
        rankDrops: [],
        counterStagnant: [],
        scoreDrops: []
    };

    Object.entries(MY_NODES).forEach(([fullAddress, name]) => {
        const variations = this.getAddressVariations(fullAddress);
        const node = allNodes.find(n => variations.some(v => n.address.includes(v)));
        if (!node) return;

        // Current values
        const currentRank = node.rank;
        const currentScore = this.cleanScore(node.score);
        const currentPrecommit = parseInt(node.precommitCounter) || 0;
        const currentCommit = parseInt(node.commitCounter) || 0;

        // 1. Check rank deterioration (higher number = worse)
        if (this.history[name].lastRank !== null && 
            currentRank > this.history[name].lastRank && 
            (currentRank - this.history[name].lastRank) > RANK_DROP_THRESHOLD) {
            alerts.rankDrops.push({
                name,
                address: node.address,
                fullAddress,
                from: this.history[name].lastRank,
                to: currentRank,
                droppedBy: currentRank - this.history[name].lastRank
            });
        }

        // 2. Check counter stagnation
        if (this.history[name].lastPrecommitCounter !== null && 
            this.history[name].lastCommitCounter !== null &&
            currentPrecommit <= this.history[name].lastPrecommitCounter && 
            currentCommit <= this.history[name].lastCommitCounter) {
            alerts.counterStagnant.push({
                name,
                address: node.address,
                fullAddress,
                precommit: currentPrecommit,
                commit: currentCommit,
                timeSinceLastIncrease: this.formatTimeSince(this.history[name].lastCounterCheckTime)
            });
        }

        // 3. Check score drops (>1%)
        if (this.history[name].lastScore !== null && 
            (this.history[name].lastScore - currentScore) > SCORE_DROP_THRESHOLD) {
            alerts.scoreDrops.push({
                name,
                address: node.address,
                fullAddress,
                from: this.history[name].lastScore.toFixed(2),
                to: currentScore.toFixed(2),
                difference: (this.history[name].lastScore - currentScore).toFixed(2)
            });
        }

        // Update history (only if counters increased)
        if (currentPrecommit > this.history[name].lastPrecommitCounter || 
            currentCommit > this.history[name].lastCommitCounter) {
            this.history[name].lastPrecommitCounter = currentPrecommit;
            this.history[name].lastCommitCounter = currentCommit;
            this.history[name].lastCounterCheckTime = Date.now();
        }

        // Always update these
        this.history[name].lastRank = currentRank;
        this.history[name].lastScore = currentScore;
    });

    this.saveHistory();
    await this.sendAlerts(alerts);
  }

  formatTimeSince(timestamp) {
    if (!timestamp) return "unknown time";
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }

  async sendAlerts(alerts) {
    let message = '';

    // 1. Rank deterioration alerts
    if (alerts.rankDrops.length > 0) {
        message += `📉 <b>Rank Deterioration (>${RANK_DROP_THRESHOLD} positions)</b>\n`;
        message += alerts.rankDrops.map(drop => 
            `🔻 <b>${drop.name}</b> (<code>${drop.address.slice(0,6)}...${drop.address.slice(-4)}</code>)\n` +
            `   Rank worsened from #${drop.from} → #${drop.to} (↓${drop.droppedBy} positions)\n` +
            `   🔗 <a href="${DASHBOARD_NODE_URL}${drop.fullAddress}">Dashboard</a> | ` +
            `<a href="${ARBISCAN_URL}${drop.fullAddress}">Arbiscan</a>`
        ).join('\n\n') + '\n\n';
    }

    // 2. Counter stagnation alerts
    if (alerts.counterStagnant.length > 0) {
        message += `⚠️ <b>Counter Stagnation (No Increase)</b>\n`;
        message += alerts.counterStagnant.map(node => 
            `⏸️ <b>${node.name}</b> (<code>${node.address.slice(0,6)}...${node.address.slice(-4)}</code>)\n` +
            `   Precommit: ${node.precommit} | Commit: ${node.commit}\n` +
            `   No increase for: ${node.timeSinceLastIncrease}\n` +
            `   🔗 <a href="${DASHBOARD_NODE_URL}${node.fullAddress}">Dashboard</a> | ` +
            `<a href="${ARBISCAN_URL}${node.fullAddress}">Arbiscan</a>`
        ).join('\n\n') + '\n\n';
    }

    // 3. Score drop alerts
    if (alerts.scoreDrops.length > 0) {
        message += `📉 <b>Score Drops (>${SCORE_DROP_THRESHOLD}%)</b>\n`;
        message += alerts.scoreDrops.map(drop => 
            `🔻 <b>${drop.name}</b> (<code>${drop.address.slice(0,6)}...${drop.address.slice(-4)}</code>)\n` +
            `   Score: ${drop.from}% → ${drop.to}% (Δ${drop.difference}%)\n` +
            `   🔗 <a href="${DASHBOARD_NODE_URL}${drop.fullAddress}">Dashboard</a> | ` +
            `<a href="${ARBISCAN_URL}${drop.fullAddress}">Arbiscan</a>`
        ).join('\n\n');
    }

    if (message) await this.sendTelegramMessage(message, true);
  }

  async generateFullReport() {
    const allNodes = await this.fetchNodeData();
    if (!allNodes) return;

    const matchedNodes = [];
    const now = new Date();
    const currentTime = now.getTime();
    const categoryChanges = [];
    const rankChanges = [];
    const scoreDrops = [];
    const performanceSummary = {};
    const rankDistribution = {
      'Top 50': 0,
      '51-100': 0,
      '101-150': 0,
      'Above 150': 0
    };

    // New: Track nodes with performance degradation
    const performanceDegradation = [];

    Object.entries(MY_NODES).forEach(([fullAddress, name]) => {
      const variations = this.getAddressVariations(fullAddress);
      const foundNode = allNodes.find(node => 
        variations.some(variant => node.address.includes(variant))
      );
      
      if (foundNode) {
        if (!this.history[name]) {
          this.history[name] = { 
            rankHistory: [], 
            precommitHistory: [],
            lastCategory: null,
            lastRankGroup: null,
            lastScore: null,
            lastRank: null,
            lastPrecommitCounter: null,
            lastCommitCounter: null,
            lastCounterCheckTime: null
          };
        }
        
        // Get current values
        const currentScore = this.cleanScore(foundNode.score);
        const currentRank = foundNode.rank;
        const currentCategory = this.getPerformanceCategory(currentScore).name;
        const currentRankGroup = this.getRankGroup(currentRank);
        
        // New: Check for performance degradation since last report
        if (this.history[name].rankHistory.length > 0) {
          const lastEntry = this.history[name].rankHistory[this.history[name].rankHistory.length - 1];
          const lastScore = this.cleanScore(lastEntry.score);
          const lastRank = lastEntry.rank;
          
          if (currentRank > lastRank || currentScore < lastScore) {
            performanceDegradation.push({
              name,
              address: foundNode.address,
              fullAddress,
              lastRank,
              currentRank,
              lastScore,
              currentScore,
              rankChange: currentRank - lastRank,
              scoreChange: (lastScore - currentScore).toFixed(2)
            });
          }
        }

        // Update performance summary
        performanceSummary[currentCategory] = (performanceSummary[currentCategory] || 0) + 1;
        
        // Update rank distribution
        if (foundNode.rank <= 50) rankDistribution['Top 50']++;
        else if (foundNode.rank <= 100) rankDistribution['51-100']++;
        else if (foundNode.rank <= 150) rankDistribution['101-150']++;
        else rankDistribution['Above 150']++;
        
        // Check for score drops > threshold
        if (this.history[name].lastScore !== null && 
            (this.history[name].lastScore - currentScore) > SCORE_DROP_THRESHOLD) {
          scoreDrops.push({
            name,
            address: foundNode.address,
            fullAddress,
            from: this.history[name].lastScore.toFixed(2),
            to: currentScore.toFixed(2),
            difference: (this.history[name].lastScore - currentScore).toFixed(2),
            rank: foundNode.rank
          });
        }
        
        // Check for category changes
        if (this.history[name].lastCategory && this.history[name].lastCategory !== currentCategory) {
          categoryChanges.push({
            name,
            address: foundNode.address,
            fullAddress,
            from: this.history[name].lastCategory,
            to: currentCategory,
            score: currentScore.toFixed(2),
            rank: foundNode.rank
          });
        }
        
        // Check for rank group changes
        if (this.history[name].lastRankGroup && this.history[name].lastRankGroup !== currentRankGroup) {
          rankChanges.push({
            name,
            address: foundNode.address,
            fullAddress,
            from: this.history[name].lastRankGroup,
            to: currentRankGroup,
            score: currentScore.toFixed(2),
            rank: foundNode.rank
          });
        }
        
        // Update history
        this.history[name].lastCategory = currentCategory;
        this.history[name].lastRankGroup = currentRankGroup;
        this.history[name].lastScore = currentScore;
        
        // Only add new entry if it's been at least reportIntervalMs since last entry
        const shouldAddEntry = this.history[name].rankHistory.length === 0 || 
          (currentTime - new Date(this.history[name].rankHistory.slice(-1)[0].timestamp).getTime()) >= FULL_REPORT_INTERVAL;

        if (shouldAddEntry) {
          this.history[name].rankHistory.push({
            timestamp: now.toISOString(),
            rank: foundNode.rank,
            score: foundNode.score || 'N/A'
          });
          this.history[name].rankHistory = this.history[name].rankHistory.slice(-HISTORY_ENTRIES_TO_SHOW);
        }

        const nodeData = {
          name,
          address: foundNode.address,
          fullAddress,
          rank: foundNode.rank,
          score: foundNode.score,
          lastActive: foundNode.lastActive,
          precommit: foundNode.precommit,
          category: this.getPerformanceCategory(foundNode.score),
          history: [...this.history[name].rankHistory]
        };
        
        matchedNodes.push(nodeData);
      }
    });

    this.saveHistory();
    matchedNodes.sort((a, b) => a.rank - b.rank);

    // 1. Send score drop alerts if any
    if (scoreDrops.length > 0) {
      let scoreDropMessage = `<b>⚠️ Score Drops Detected (>${SCORE_DROP_THRESHOLD}% decrease)</b>\n\n`;
      scoreDropMessage += scoreDrops.map(drop => 
        `🔻 <b>${drop.name}</b> (<code>${drop.address.slice(0, 6)}...${drop.address.slice(-4)}</code>)\n` +
        `📉 Score dropped from ${drop.from}% to ${drop.to}% (Δ${drop.difference}%)\n` +
        `🏅 Rank: ${drop.rank}\n` +
        `🔗 <a href="${DASHBOARD_NODE_URL}${drop.fullAddress}">Dashboard</a> | ` +
        `<a href="${ARBISCAN_URL}${drop.fullAddress}">Arbiscan</a>`
      ).join('\n\n');
      
      await this.sendTelegramMessage(scoreDropMessage, true);
    }

    // 2. Send category/rank changes if any
    if (categoryChanges.length > 0 || rankChanges.length > 0) {
      let changesMessage = '<b>🔄 Performance Changes Detected</b>\n\n';
      
      if (categoryChanges.length > 0) {
        changesMessage += '<b>📊 Performance Category Changes:</b>\n';
        changesMessage += categoryChanges.map(change => 
          `🔀 <b>${change.name}</b> (<code>${change.address.slice(0, 6)}...${change.address.slice(-4)}</code>)\n` +
          `   ${change.from} → ${change.to}\n` +
          `⭐ Score: ${change.score}% | 🏅 Rank: ${change.rank}\n` +
          `🔗 <a href="${DASHBOARD_NODE_URL}${change.fullAddress}">Dashboard</a> | ` +
          `<a href="${ARBISCAN_URL}${change.fullAddress}">Arbiscan</a>`
        ).join('\n\n') + '\n\n';
      }
      
      if (rankChanges.length > 0) {
        changesMessage += '<b>🏅 Rank Group Changes:</b>\n';
        changesMessage += rankChanges.map(change => 
          `🔀 <b>${change.name}</b> (<code>${change.address.slice(0, 6)}...${change.address.slice(-4)}</code>)\n` +
          `   ${change.from} → ${change.to}\n` +
          `⭐ Score: ${change.score}% | 🏅 Rank: ${change.rank}\n` +
          `🔗 <a href="${DASHBOARD_NODE_URL}${change.fullAddress}">Dashboard</a> | ` +
          `<a href="${ARBISCAN_URL}${change.fullAddress}">Arbiscan</a>`
        ).join('\n\n');
      }
      
      await this.sendTelegramMessage(changesMessage);
    }

    // 3. Send regular report
    const reportParts = [];
    
    // Performance Summary Section
    let summaryReport = `<b>📊 Node Performance Report</b>\n\n`;
    summaryReport += `<b>📈 Performance Summary</b>\n<code>════════════════════</code>\n`;
    PERFORMANCE_CATEGORIES.forEach(cat => {
      if (performanceSummary[cat.name]) {
        summaryReport += `${cat.emoji} ${cat.name}: ${performanceSummary[cat.name]} node(s)\n`;
      }
    });
    
    // Rank Distribution Section
    summaryReport += `\n<b>🏅 Rank Distribution</b>\n<code>════════════════════</code>\n`;
    summaryReport += `🥇 Top 50: ${rankDistribution['Top 50']} node(s)\n`;
    summaryReport += `🥈 51-100: ${rankDistribution['51-100']} node(s)\n`;
    summaryReport += `🥉 101-150: ${rankDistribution['101-150']} node(s)\n`;
    summaryReport += `📊 Above 150: ${rankDistribution['Above 150']} node(s)\n`;
    reportParts.push(summaryReport);

    // Node Details with History
    const nodeGroups = [];
    for (let i = 0; i < matchedNodes.length; i += 3) {
      nodeGroups.push(matchedNodes.slice(i, i + 3));
    }

    nodeGroups.forEach((group, groupIndex) => {
      let nodeReport = `<b>🔍 Node Details [${groupIndex + 1}/${nodeGroups.length}]</b>\n\n`;
      group.forEach(node => {
        nodeReport += `<u>${node.name}</u>\n`;
        nodeReport += `🆔 <code>${node.address}</code>\n`;
        nodeReport += `🔗 <a href="${DASHBOARD_NODE_URL}${node.fullAddress}">Dashboard</a> | ` +
                      `<a href="${ARBISCAN_URL}${node.fullAddress}">Arbiscan</a>\n`;
        nodeReport += `🎯 Rank: <b>#${node.rank}</b>\n`;
        nodeReport += `📊 Score: <b style="color: ${node.category.color}">${node.score}%</b> ${node.category.emoji}\n`;
        nodeReport += `⏱ Last Active: ${node.lastActive}\n`;
        
        if (node.precommit && node.precommit !== 'N/A') {
          nodeReport += `✅ Precommit: ${node.precommit}\n`;
        }

        if (node.history && node.history.length > 0) {
          nodeReport += `\n<b>📅 Last ${node.history.length} entries (${FULL_REPORT_INTERVAL/60000} min intervals):</b>\n`;
          const lastEntries = [...node.history].reverse();
          nodeReport += lastEntries.map(entry => 
            `• ${new Date(entry.timestamp).toLocaleTimeString()}: ` +
            `Rank #${entry.rank} (Score: ${String(entry.score).replace(/%%/g, '%')})`
          ).join('\n');
        }
        
        nodeReport += `\n`;
      });
      reportParts.push(nodeReport);
    });

    // 4. Add performance degradation summary
    if (performanceDegradation.length > 0) {
      let degradationReport = `<b>📉 Performance Degradation Summary (Last 2 Hours)</b>\n\n`;
      
      degradationReport += performanceDegradation.map(node => {
        let changes = [];
        if (node.rankChange > 0) changes.push(`Rank ↓${node.rankChange} (#${node.lastRank} → #${node.currentRank})`);
        if (node.scoreChange > 0) changes.push(`Score ↓${node.scoreChange}% (${node.lastScore}% → ${node.currentScore}%)`);
        
        return `🔻 <b>${node.name}</b> (<code>${node.address.slice(0,6)}...${node.address.slice(-4)}</code>)\n` +
               `   ${changes.join(' | ')}\n` +
               `   🔗 <a href="${DASHBOARD_NODE_URL}${node.fullAddress}">Dashboard</a> | ` +
               `<a href="${ARBISCAN_URL}${node.fullAddress}">Arbiscan</a>`;
      }).join('\n\n');

      reportParts.push(degradationReport);
    }

    // Send all report parts
    for (const part of reportParts) {
      await this.sendTelegramMessage(part);
      await new Promise(r => setTimeout(r, 500));
    }

    this.lastReportTime = now;
  }

  saveHistory() {
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(this.history, null, 2));
    } catch (e) {
      console.error('Error saving history:', e.message);
    }
  }
}

// Start the monitor
const monitor = new NodeMonitor();
console.log('⏰ Starting monitoring...');
console.log(`🔔 Activity checks every ${ACTIVITY_CHECK_INTERVAL/60000} minutes`);
console.log(`⏳ Hourly checks every ${HOURLY_CHECK_INTERVAL/60000} minutes`);
console.log(`📊 Full reports every ${FULL_REPORT_INTERVAL/60000} minutes`);

// Initial checks
monitor.checkNodeActivity();
monitor.generateFullReport();
monitor.hourlyChecks();

// Schedule regular checks
setInterval(() => monitor.checkNodeActivity(), ACTIVITY_CHECK_INTERVAL);
setInterval(() => monitor.hourlyChecks(), HOURLY_CHECK_INTERVAL);
setInterval(() => monitor.generateFullReport(), FULL_REPORT_INTERVAL);

process.on('SIGINT', () => {
  console.log('🛑 Stopped all monitoring');
  process.exit();
});
