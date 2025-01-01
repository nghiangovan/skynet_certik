const CertikCrawler = require('./CertikCrawler');
const cron = require('node-cron');
const os = require('os');
require('dotenv').config();

// Configuration object
const config = {
  mongoUrl: process.env.MONGO_URL,
  securityScoresCollection: process.env.SECURITY_SCORES_COLLECTION,
  marketDataCollection: process.env.MARKET_DATA_COLLECTION,
  maxThreads: process.env.MAX_THREADS ? parseInt(process.env.MAX_THREADS, 10) : Math.max(os.cpus().length - 2, 1),
  maxTopsProjects: process.env.MAX_TOPS_PROJECTS ? parseInt(process.env.MAX_TOPS_PROJECTS, 10) : null,
  proxies: [],
};

// Validate required environment variables
if (!config.mongoUrl || !config.securityScoresCollection || !config.marketDataCollection) {
  console.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

async function handleDailyMarketData() {
  try {
    const crawler = new CertikCrawler(config);
    console.log('Running daily market data crawler...');
    await crawler.crawlData(config.marketDataCollection);
  } catch (error) {
    console.error('Error in daily market data crawler:', error);
  }
}

async function handleSynchronizedCrawl() {
  try {
    const crawler = new CertikCrawler(config);
    console.log('Running synchronized crawl for both collections market data and security scores...');
    await crawler.crawlData([config.securityScoresCollection, config.marketDataCollection], { synchronized: true });
  } catch (error) {
    console.error('Error in synchronized crawl:', error);
  }
}

async function main() {
  try {
    // Run initial synchronized crawl
    await handleSynchronizedCrawl();

    // Set up scheduled jobs
    console.log('Setting up scheduled crawlers...');
    cron.schedule(
      '0 0 * * *',
      async () => {
        if (new Date().getDay() === 0) {
          // On Sundays, run synchronized a both market data and security scores
          await handleSynchronizedCrawl();
        } else {
          // On other days, only run market data
          await handleDailyMarketData();
        }
      },
      {
        timezone: 'UTC',
      },
    );

    console.log('Crawlers scheduled (all times in UTC):');
    console.log('- Market Data: Daily at 00:00 UTC');
    console.log('- Synchronized Market Data and Security Scores: Sundays at 00:00 UTC');
  } catch (error) {
    console.error('An error occurred during main execution:', error);
  }
}

// Run the main function
main().catch(console.error);

// Handle process termination
process.on('SIGINT', async () => {
  console.log('Received SIGINT. Cleaning up...');
  try {
    const crawler = new CertikCrawler(config);
    await crawler.close();
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
  process.exit(0);
});

// Keep the process running
process.stdin.resume();
