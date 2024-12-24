const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config();
const os = require('os');
const cron = require('node-cron');

let browser = null;
let mongoClient = null;

// MongoDB Configuration from .env
const MONGO_URL = process.env.MONGO_URL;
const SECURITY_SCORES_COLLECTION = process.env.SECURITY_SCORES_COLLECTION;
const MARKET_DATA_COLLECTION = process.env.MARKET_DATA_COLLECTION;

// Validate required environment variables
if (!MONGO_URL || !SECURITY_SCORES_COLLECTION || !MARKET_DATA_COLLECTION) {
  console.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

async function saveCookies(cookies) {
  await fs.writeFile(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
}

async function loadCookies() {
  try {
    const cookiesString = await fs.readFile(path.join(__dirname, 'cookies.json'), 'utf-8');
    return JSON.parse(cookiesString);
  } catch (error) {
    return [];
  }
}

async function setupRequestInterception(page) {
  await page.setRequestInterception(true);

  page.on('request', request => {
    if (request.url().includes('query-leaderboard-projects')) {
      const headers = {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'priority': 'u=1, i',
        'referer': 'https://skynet.certik.com/leaderboards/security',
      };

      request.continue({ headers });
    } else {
      request.continue();
    }
  });
}

async function initializeBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: false, // Set to false for debugging
      defaultViewport: null,
    });
  }
  return browser;
}

function extractSecurityScoreData(project) {
  return {
    _id: project.id,
    id: project.id,
    audits: project.audits,
    has3rdPartyAudit: project.has3rdPartyAudit,
    badges: project.badges,
    kycAssessment: project.kycAssessment,
    labels: project.labels,
    contentfulLogo: project.contentfulLogo,
    contentfulDarkModeLogo: project.contentfulDarkModeLogo,
    name: project.name,
    securityScoreV3: project.securityScoreV3,
    selfReportedMarketCap: project.selfReportedMarketCap,
    projectTokenStatus: project.projectTokenStatus,
    newSecurityScore: project.newSecurityScore,
    fetchedAt: new Date(),
    updateTimestamp: new Date(),
  };
}

function extractMarketData(project) {
  return {
    _id: project.id,
    id: project.id,
    labels: project.labels,
    marketCap: project.marketCap,
    marketCapType: project.marketCapType,
    name: project.name,
    onboardedAt: project.onboardedAt,
    percentChangeInPrice: project.percentChangeInPrice,
    previousPrice: project.previousPrice,
    price: project.price,
    selfReportedMarketCap: project.selfReportedMarketCap,
    projectTokenStatus: project.projectTokenStatus,
    tradingVolume: project.tradingVolume,
    previousTradingVolume: project.previousTradingVolume,
    fetchedAt: new Date(),
    updateTimestamp: new Date(),
  };
}

async function fetchRangeData({ startSkip, endSkip, limit, pageIndex, collectionName }) {
  let page = null;

  try {
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60000);

    // Load cookies
    const cookies = await loadCookies();
    if (cookies.length) {
      await page.setCookie(...cookies);
    }

    // Setup request interception
    await setupRequestInterception(page);

    // Visit the page first to establish session
    await page.goto('https://skynet.certik.com/leaderboards/security', {
      waitUntil: 'networkidle0',
      timeout: 60000,
    });

    // Wait additional time to ensure page is ready
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Connect to MongoDB
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGO_URL);
      await mongoClient.connect();
    }
    const db = mongoClient.db();
    const collection = db.collection(collectionName);

    // Fetch data for assigned range
    for (let skip = startSkip; skip <= endSkip; skip += limit) {
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          const response = await page.evaluate(
            async ({ skip, limit }) => {
              const res = await fetch(
                `https://skynet.certik.com/api/leaderboard-all-projects/query-leaderboard-projects?limit=${limit}&skip=${skip}`,
                {
                  method: 'GET',
                  credentials: 'include',
                  headers: {
                    'accept': '*/*',
                    'accept-language': 'en-US,en;q=0.9',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-origin',
                    'referer': 'https://skynet.certik.com/leaderboards/security',
                  },
                },
              );
              if (!res.ok) {
                throw new Error(`HTTP error! status: ${res.status}`);
              }
              return await res.json();
            },
            { skip, limit },
          );

          if (!response || !response.items) {
            throw new Error(`Invalid response at skip=${skip}`);
          }

          // Extract data based on collection type
          const projectsWithMetadata = response.items.map(project =>
            collectionName === SECURITY_SCORES_COLLECTION
              ? extractSecurityScoreData(project)
              : extractMarketData(project),
          );

          // Bulk upsert operations
          const bulkOps = projectsWithMetadata.map(project => ({
            updateOne: {
              filter: { _id: project._id },
              update: {
                $set: project,
                $setOnInsert: { firstFetchedAt: new Date() },
              },
              upsert: true,
            },
          }));

          if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps);
          }

          console.log(`Worker ${pageIndex + 1} processed skip=${skip}, items=${bulkOps.length}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          break;
        } catch (error) {
          retryCount++;
          if (retryCount === maxRetries) throw error;
          console.log(`Retry ${retryCount}/${maxRetries} for skip=${skip}`);
          await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
        }
      }
    }

    return 'completed';
  } catch (error) {
    console.error(`Worker ${pageIndex + 1} error:`, error);
    throw error;
  } finally {
    if (page) await page.close();
  }
}

async function ensureCollections() {
  try {
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGO_URL);
      await mongoClient.connect();
    }
    const db = mongoClient.db();

    // Get list of existing collections
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(col => col.name);

    // Create security scores collection if it doesn't exist
    if (!collectionNames.includes(SECURITY_SCORES_COLLECTION)) {
      await db.createCollection(SECURITY_SCORES_COLLECTION);
      console.log(`Created collection: ${SECURITY_SCORES_COLLECTION}`);

      // Create indexes for security scores collection
      await db
        .collection(SECURITY_SCORES_COLLECTION)
        .createIndexes([
          { key: { id: 1 }, unique: true },
          { key: { fetchedAt: 1 } },
          { key: { 'securityScoreV3.rank': 1 } },
          { key: { 'newSecurityScore.rank': 1 } },
        ]);
    }

    // Create market data collection if it doesn't exist
    if (!collectionNames.includes(MARKET_DATA_COLLECTION)) {
      await db.createCollection(MARKET_DATA_COLLECTION);
      console.log(`Created collection: ${MARKET_DATA_COLLECTION}`);

      // Create indexes for market data collection
      await db
        .collection(MARKET_DATA_COLLECTION)
        .createIndexes([
          { key: { id: 1 }, unique: true },
          { key: { fetchedAt: 1 } },
          { key: { marketCap: -1 } },
          { key: { tradingVolume: -1 } },
        ]);
    }
  } catch (error) {
    console.error('Error ensuring collections:', error);
    throw error;
  }
}

async function crawlData(collectionName) {
  try {
    // Ensure collections exist before starting crawl
    await ensureCollections();

    browser = await initializeBrowser();
    const page = await browser.newPage();
    await setupRequestInterception(page);

    // Setup request interception for initial page
    await setupRequestInterception(page);

    await page.goto('https://skynet.certik.com/leaderboards/security', {
      waitUntil: 'networkidle0',
      timeout: 60000, // Increase timeout to 60 seconds
    });

    const currentCookies = await page.cookies();
    await saveCookies(currentCookies);

    // Get total items using the same page
    const initialResponse = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2s to ensure page is ready

      const res = await fetch(
        'https://skynet.certik.com/api/leaderboard-all-projects/query-leaderboard-projects?limit=50&skip=0',
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            'accept': '*/*',
            'accept-language': 'en-US,en;q=0.9',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'referer': 'https://skynet.certik.com/leaderboards/security',
          },
        },
      );

      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      return await res.json();
    });

    await page.close();

    const totalItems = initialResponse.page.total;
    console.log(`Total items to fetch: ${totalItems}`);

    // Calculate ranges for workers
    const limit = 50;
    const numTabs = Math.min(os.cpus().length - 1, 4); // Limit to 4 tabs max
    const itemsPerTab = Math.ceil(totalItems / numTabs);

    const tabPromises = [];

    // Create and start tabs
    for (let i = 0; i < numTabs; i++) {
      const startSkip = i * itemsPerTab;
      const endSkip = Math.min((i + 1) * itemsPerTab - 1, totalItems - 1);

      console.log(`Starting tab ${i + 1}/${numTabs} for range ${startSkip}-${endSkip}`);

      const tabData = {
        startSkip,
        endSkip,
        limit,
        pageIndex: i,
        collectionName,
      };

      // Add delay between starting tabs
      await new Promise(resolve => setTimeout(resolve, 1000));
      tabPromises.push(fetchRangeData(tabData));
    }

    // Wait for all tabs to complete
    const results = await Promise.allSettled(tabPromises);
    console.log('All tabs completed');

    // Log any errors
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Tab ${index + 1} failed:`, result.reason);
      }
    });
  } catch (error) {
    console.error('An error occurred:', error);
  } finally {
    if (browser) {
      await browser.close();
      browser = null;
    }
    if (mongoClient) {
      await mongoClient.close();
      mongoClient = null;
    }
  }
}

// Schedule handlers
async function handleSecurityScoreSchedule() {
  console.log('Starting weekly security score crawl...');
  await crawlData(SECURITY_SCORES_COLLECTION);
}

async function handleMarketDataSchedule() {
  console.log('Starting daily market data crawl...');
  await crawlData(MARKET_DATA_COLLECTION);
}

// Handle process termination
process.on('SIGINT', async () => {
  if (browser) await browser.close();
  if (mongoClient) await mongoClient.close();
  process.exit();
});

// Replace the command line argument handling with this:
const args = process.argv.slice(2);

if (args[0] === 'security') {
  handleSecurityScoreSchedule();
} else if (args[0] === 'market') {
  handleMarketDataSchedule();
} else if (args[0] === 'dev') {
  // Development mode - run both crawlers immediately
  console.log('Running in development mode - executing both crawlers...');
  handleSecurityScoreSchedule();
  setTimeout(handleMarketDataSchedule, 5000); // Run market data crawler 5 seconds after security
} else {
  // Production mode - set up scheduled jobs
  console.log('Starting scheduled crawlers...');

  // Schedule security score crawler to run every Sunday at 00:30 UTC
  cron.schedule(
    '30 0 * * 0',
    () => {
      console.log('Running scheduled security score crawler...');
      handleSecurityScoreSchedule();
    },
    {
      timezone: 'UTC',
    },
  );

  // Schedule market data crawler to run daily at 00:00 UTC
  cron.schedule(
    '0 0 * * *',
    () => {
      console.log('Running scheduled market data crawler...');
      handleMarketDataSchedule();
    },
    {
      timezone: 'UTC',
    },
  );

  console.log('Crawlers scheduled (all times in UTC):');
  console.log('- Security Scores: Every Sunday at 00:30 UTC');
  console.log('- Market Data: Daily at 00:00 UTC');
}

// Keep the process running
process.stdin.resume();
