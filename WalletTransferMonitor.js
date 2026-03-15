const axios = require('axios');
const express = require('express');
const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  clusterApiUrl,
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, getMint } = require('@solana/spl-token');
require('dotenv').config();

// Configuration constants
const CONFIG = {
  RATE_LIMIT: {
    BASE_DELAY_MS: 2000,
    BACKOFF_MS: 15000,
    MAX_BACKOFF_MS: 60000,
    MAX_RETRIES: 3
  },
  WEBSOCKET: {
    MAX_RETRIES: 10,
    BASE_DELAY_MS: 5000
  },
  HEALTH_CHECK: {
    INTERVAL_MS: 30000
  },
  TELEGRAM: {
    MESSAGE_PREVIEW: false
  }
};

// Logger utility
const logger = {
  info: (message, ...args) => console.log(`[INFO] ${message}`, ...args),
  error: (message, ...args) => console.error(`[ERROR] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`[WARN] ${message}`, ...args),
  debug: (message, ...args) => process.env.DEBUG && console.log(`[DEBUG] ${message}`, ...args)
};

class WalletTransferMonitor {
  constructor(walletAddress, wssUrl, rpcUrl = clusterApiUrl('mainnet-beta'), webhookUrl = 'http://localhost:3000/webhook/transfer') {
    this.wallet = new PublicKey(walletAddress);
    this.walletAddress = walletAddress;

    this.connection = new Connection(rpcUrl, {
      wsEndpoint: wssUrl || rpcUrl.replace(/^http/, 'wss://'),
      commitment: 'confirmed',
      disableRetryOnRateLimit: false,
      confirmTransactionInitialTimeout: 60000
    });

    this.webhookUrl = webhookUrl;
    this.logSubscriptionId = null;
    this.isMonitoring = false;
    this.wsRetryCount = 0;
    
    // Queue management
    this.transactionQueue = [];
    this.isProcessing = false;
    this.consecutiveErrors = 0;
    this.lastRequestTime = 0;
  }

  // Rate limiting
  async waitForRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < CONFIG.RATE_LIMIT.BASE_DELAY_MS) {
      const waitTime = CONFIG.RATE_LIMIT.BASE_DELAY_MS - timeSinceLastRequest;
      await this.sleep(waitTime);
    }
    
    this.lastRequestTime = Date.now();
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Webhook communication
  async sendToWebhook(type, data) {
    try {
      logger.debug(`Sending ${type} notification to webhook`);
      await axios.post(this.webhookUrl, { type, data }, {
        timeout: 5000,
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      logger.error(`Webhook send failed: ${error.message}`);
    }
  }

  // Connection management
  async testConnection() {
    try {
      logger.info('Testing RPC connection...');
      const version = await this.connection.getVersion();
      logger.info(`RPC connected successfully:`, version);
      this.consecutiveErrors = 0;
      return true;
    } catch (error) {
      logger.error(`RPC connection failed: ${error.message}`);
      return false;
    }
  }

  async checkConnectionHealth() {
    try {
      await this.connection.getSlot();
      return true;
    } catch {
      return false;
    }
  }

  // WebSocket setup with retry logic
  async setupWebSocket() {
    return new Promise((resolve, reject) => {
      const attemptConnection = () => {
        try {
          this.logSubscriptionId = this.connection.onLogs(
            this.wallet,
            this.handleLogs.bind(this),
            'confirmed'
          );

          logger.info('WebSocket connected successfully');
          this.wsRetryCount = 0;
          resolve();
        } catch (error) {
          this.handleWebSocketError(error, attemptConnection, reject);
        }
      };

      attemptConnection();
    });
  }

  handleWebSocketError(error, retryCallback, reject) {
    const errorMessage = error.message || error.toString();
    
    if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests')) {
      this.wsRetryCount++;
      const delay = Math.min(
        CONFIG.WEBSOCKET.BASE_DELAY_MS * Math.pow(2, this.wsRetryCount),
        CONFIG.RATE_LIMIT.MAX_BACKOFF_MS
      );
      
      logger.warn(`Rate limited. Retrying WebSocket in ${delay/1000}s (attempt ${this.wsRetryCount}/${CONFIG.WEBSOCKET.MAX_RETRIES})`);
      
      if (this.wsRetryCount <= CONFIG.WEBSOCKET.MAX_RETRIES) {
        setTimeout(retryCallback, delay);
      } else {
        reject(new Error('Max WebSocket retries exceeded'));
      }
    } else {
      logger.error(`WebSocket connection failed: ${errorMessage}`);
      reject(error);
    }
  }

  // Log handler
  handleLogs(logs) {
    if (logs.err) {
      this.handleLogError(logs.err);
      return;
    }

    this.wsRetryCount = 0;

    if (this.isRelevantLog(logs.logs)) {
      logger.info(`Detected relevant transaction: ${logs.signature}`);
      this.transactionQueue.push(logs.signature);
      
      if (!this.isProcessing) {
        this.processQueue();
      }
    }
  }

  handleLogError(error) {
    const errorStr = error.toString();
    if (errorStr.includes('429') || errorStr.includes('Too Many Requests')) {
      logger.warn('Rate limit hit in WebSocket, will retry...');
      this.reconnectWebSocket();
    } else {
      logger.error('Logs callback error:', error);
    }
  }

  isRelevantLog(logs) {
    return logs.some(log =>
      log.includes('Transfer') ||
      log.includes(TOKEN_PROGRAM_ID.toBase58()) ||
      log.includes('system')
    );
  }

  async reconnectWebSocket() {
    if (this.logSubscriptionId) {
      try {
        await this.connection.removeOnLogsListener(this.logSubscriptionId);
      } catch (error) {
        logger.error(`Failed to remove subscription: ${error.message}`);
      }
    }
    
    this.setupWebSocket().catch(error => {
      logger.error(`WebSocket reconnection failed: ${error.message}`);
    });
  }

  // Public methods
  async start() {
    if (this.isMonitoring) {
      logger.warn('Already monitoring.');
      return;
    }

    logger.info(`Starting monitor for wallet: ${this.walletAddress}`);

    const connectionOk = await this.testConnection();
    if (!connectionOk) {
      logger.error('Cannot start - connection failed');
      return;
    }
    
    try {
      await this.setupWebSocket();
      this.isMonitoring = true;
      logger.info('Monitoring active. Waiting for transfers...');
    } catch (error) {
      logger.error(`Failed to start monitoring: ${error.message}`);
      this.isMonitoring = false;
    }
  }

  async stop() {
    if (!this.isMonitoring || !this.logSubscriptionId) return;

    try {
      await this.connection.removeOnLogsListener(this.logSubscriptionId);
      logger.info('Subscription removed.');
    } catch (error) {
      logger.error(`Failed to remove subscription: ${error.message}`);
    }

    this.logSubscriptionId = null;
    this.isMonitoring = false;
    this.transactionQueue = [];
    logger.info('Monitor stopped.');
  }

  // Queue processing
  async processQueue() {
    if (this.isProcessing || this.transactionQueue.length === 0) return;
    
    const isHealthy = await this.checkConnectionHealth();
    if (!isHealthy) {
      logger.warn('Connection unhealthy, waiting...');
      await this.sleep(5000);
      this.isProcessing = false;
      return;
    }
    
    this.isProcessing = true;

    while (this.transactionQueue.length > 0) {
      const signature = this.transactionQueue.shift();
      await this.processTransaction(signature);
    }

    this.isProcessing = false;
  }

  async processTransaction(signature) {
    try {
      await this.waitForRateLimit();
      
      const transaction = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      if (!transaction) {
        logger.debug(`Transaction not found: ${signature}`);
        return;
      }

      await this.parseAndHandleTransaction(transaction, signature);
      
      this.consecutiveErrors = 0;
      await this.sleep(CONFIG.RATE_LIMIT.BASE_DELAY_MS);
      
    } catch (error) {
      await this.handleTransactionError(error, signature);
    }
  }

  async parseAndHandleTransaction(tx, signature) {
    const { transaction, meta, slot, blockTime } = tx;
    
    if (!meta || meta.err) return;

    const allInstructions = [
      ...transaction.message.instructions,
      ...(meta.innerInstructions || []).flatMap(inner => inner.instructions),
    ];

    const timestamp = blockTime
      ? new Date(blockTime * 1000).toISOString()
      : 'unknown';

    for (const instruction of allInstructions) {
      await this.parseInstruction(instruction, signature, slot, timestamp);
    }
  }

  async parseInstruction(instruction, signature, slot, timestamp) {
    if (!instruction.parsed) return;

    const { program, type, info } = instruction.parsed;
    
    // System transfer detection
    if (this.isSystemTransfer(program, type, info)) {
      await this.handleSystemTransfer(info, signature, slot, timestamp);
    }
    // Token transfer detection
    else if (this.isTokenTransfer(program, type, info)) {
      await this.handleTokenTransfer(info, signature, slot, timestamp);
    }
  }

  isSystemTransfer(program, type, info) {
    return (program === 'system' || (!program && info?.lamports)) && 
           (type === 'transfer' || type === 'transferChecked');
  }

  isTokenTransfer(program, type, info) {
    return (program === 'spl-token' || (!program && info?.mint)) && 
           (type === 'transfer' || type === 'transferChecked');
  }

  async handleSystemTransfer(info, signature, slot, timestamp) {
    const { source, destination, lamports } = info;
    const amountSol = (lamports / LAMPORTS_PER_SOL).toFixed(6);
    const direction = source === this.walletAddress ? 'OUT' : 'IN';

    logger.info(
      `[SOL ${direction}] ${amountSol} SOL\n` +
      `  From: ${source}\n` +
      `  To:   ${destination}\n` +
      `  Tx:   ${signature}\n` +
      `  Slot: ${slot} | Time: ${timestamp}`
    );

    await this.sendToWebhook('SOL_TRANSFER', {
      direction,
      amountSol,
      source,
      destination,
      signature,
      slot,
      time: timestamp
    });
  }

  async handleTokenTransfer(info, signature, slot, timestamp) {
    const { source, destination, mint, amount, tokenAmount } = info;

    let uiAmount = tokenAmount?.uiAmount;
    if (uiAmount == null) {
      const decimals = tokenAmount?.decimals ?? 9;
      uiAmount = Number(amount) / 10 ** decimals;
    }

    const symbol = await this.getTokenSymbol(mint);
    const direction = source.includes(this.walletAddress) ? 'OUT' : 'IN';

    logger.info(
      `[TOKEN ${direction}] ${uiAmount.toFixed(6)} ${symbol}\n` +
      `  Mint:     ${mint}\n` +
      `  From ATA: ${source}\n` +
      `  To ATA:   ${destination}\n` +
      `  Tx:       ${signature}\n` +
      `  Slot:     ${slot} | Time: ${timestamp}`
    );

    await this.sendToWebhook('TOKEN_TRANSFER', {
      direction,
      amount: uiAmount,
      symbol,
      mint,
      source,
      destination,
      signature,
      slot,
      time: timestamp
    });
  }

  async getTokenSymbol(mint) {
    try {
      const mintPk = new PublicKey(mint);
      const mintInfo = await getMint(this.connection, mintPk);
      return mintInfo.data.symbol?.trim() || `${mint.slice(0, 6)}...`;
    } catch {
      return `${mint.slice(0, 6)}...`;
    }
  }

  async handleTransactionError(error, signature) {
    if (error.message?.includes('429')) {
      this.consecutiveErrors++;
      const backoffTime = Math.min(
        CONFIG.RATE_LIMIT.BACKOFF_MS * Math.pow(2, this.consecutiveErrors - 1),
        CONFIG.RATE_LIMIT.MAX_BACKOFF_MS
      );
      
      logger.warn(`Rate limited on ${signature} → backing off ${backoffTime}ms (error #${this.consecutiveErrors})`);
      await this.sleep(backoffTime);
      this.transactionQueue.unshift(signature);
      
    } else if (error.message?.includes('timeout')) {
      logger.warn(`Request timeout for ${signature}, requeueing...`);
      this.transactionQueue.unshift(signature);
      await this.sleep(5000);
      
    } else {
      this.consecutiveErrors = 0;
      logger.error(`Transaction ${signature} error: ${error.message}`);
    }
  }
}

// Telegram Service
class TelegramService {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async sendMessage(message) {
    try {
      const response = await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: CONFIG.TELEGRAM.MESSAGE_PREVIEW
      });
      return response.data;
    } catch (error) {
      logger.error(`Telegram send failed: ${error.response?.data || error.message}`);
      throw error;
    }
  }

  formatTransfer(type, data) {
    const explorerUrl = `https://solscan.io/tx/${data.signature}`;
    const shortSource = this.shortenAddress(data.source);
    const shortDest = this.shortenAddress(data.destination);
    
    if (type === 'SOL') {
      return this.formatSolTransfer(data, explorerUrl, shortSource, shortDest);
    } else {
      return this.formatTokenTransfer(data, explorerUrl, shortSource, shortDest);
    }
  }

  shortenAddress(address) {
    return `${address.slice(0, 8)}...${address.slice(-8)}`;
  }

  formatSolTransfer(data, explorerUrl, shortSource, shortDest) {
    const emoji = data.direction === 'IN' ? '📥' : '📤';
    
    return `${emoji} <b>SOL ${data.direction}</b>\n` +
           `💰 <b>Amount:</b> ${data.amountSol} SOL\n` +
           `📤 <b>From:</b> <code>${shortSource}</code>\n` +
           `📥 <b>To:</b> <code>${shortDest}</code>\n` +
           `🔗 <b>Tx:</b> <a href="${explorerUrl}">View</a>\n` +
           `⏱ <b>Time:</b> ${new Date(data.time).toLocaleString()}`;
  }

  formatTokenTransfer(data, explorerUrl, shortSource, shortDest) {
    const emoji = data.direction === 'IN' ? '📥' : '📤';
    const shortMint = this.shortenAddress(data.mint);
    
    return `${emoji} <b>Token ${data.direction}</b>\n` +
           `💰 <b>Amount:</b> ${data.amount.toFixed(6)} ${data.symbol}\n` +
           `🪙 <b>Mint:</b> <code>${shortMint}</code>\n` +
           `📤 <b>From:</b> <code>${shortSource}</code>\n` +
           `📥 <b>To:</b> <code>${shortDest}</code>\n` +
           `🔗 <b>Tx:</b> <a href="${explorerUrl}">View</a>\n` +
           `⏱ <b>Time:</b> ${new Date(data.time).toLocaleString()}`;
  }
}

// Express Server Setup
const app = express();
app.use(express.json());

// Initialize services
const telegram = new TelegramService(
  process.env.TELEGRAM_BOT_TOKEN,
  process.env.TELEGRAM_CHAT_ID
);

// Webhook endpoint
app.post('/webhook/transfer', async (req, res) => {
  try {
    const { type, data } = req.body;
    
    if (!type || !data) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const transferType = type.replace('_TRANSFER', '');
    const message = telegram.formatTransfer(transferType, data);
    
    await telegram.sendMessage(message);
    
    res.json({ 
      success: true, 
      message: 'Notification sent successfully' 
    });
    
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).json({ 
      error: 'Failed to send notification',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  logger.info(`Webhook server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  logger.info('Received shutdown signal, cleaning up...');
  
  server.close(() => {
    logger.info('HTTP server closed');
  });
  
  if (monitor) {
    await monitor.stop();
  }
  
  process.exit(0);
}

// Main execution
let monitor;

(async () => {
  try {
    const walletAddress = process.env.WALLET_ADDRESS || 'BM9CcyErJcu2mjrFvUsRRrD3snGeHDDVirJLvL6EjvMN';
    const webhookUrl = `http://localhost:${PORT}/webhook/transfer`;

    logger.info('Configuration:');
    logger.info(`- Wallet: ${walletAddress}`);
    logger.info(`- RPC URL: ${process.env.RPC_URL}`);
    logger.info(`- Webhook: ${webhookUrl}`);



    monitor = new WalletTransferMonitor(
      walletAddress,
      process.env.RPC_URL,
      clusterApiUrl('mainnet-beta'),
      webhookUrl
    );

    await monitor.start();

  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
})();