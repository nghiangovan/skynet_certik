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

const MAX_TOPS_PROJECTS = process.env.MAX_TOPS_PROJECTS ? parseInt(process.env.MAX_TOPS_PROJECTS, 10) : null;

// Add these constants at the top
const MAX_THREADS = process.env.MAX_THREADS ? parseInt(process.env.MAX_THREADS, 10) : Math.max(os.cpus().length - 2, 1); // Use default if not set in env
const BATCH_SIZE = 50;
const MAX_RETRIES = 3;

// Delay constants (all in milliseconds)
const DELAY_BETWEEN_CRAWLERS = 30 * 60 * 1000; // 30 minutes between crawlers
const DELAY_INITIAL_PAGE_LOAD = 30 * 1000; // 30 seconds for initial page load
const DELAY_BETWEEN_BATCHES = {
  // Random delay between batch requests
  MIN: 30 * 1000, // Minimum 30 seconds
  MAX: 40 * 1000, // Maximum 40 seconds
};
const DELAY_ON_RETRY = {
  // Random delay for retry attempts
  MIN: 30 * 1000, // Minimum 30 seconds
  MAX: 40 * 1000, // Maximum 40 seconds
};
const DELAY_BETWEEN_TABS = 1000; // 1 second between starting new tabs
const DELAY_API_READINESS = 3000; // 3 seconds for API readiness

// Add these at the top with other requires and constants
const PROXIES = process.env.PROXIES ? JSON.parse(process.env.PROXIES) : [];

// Add proxy rotation function
function getNextProxy() {
  if (!PROXIES.length) return null;

  // Rotate through proxies
  const proxy = PROXIES.shift();
  PROXIES.push(proxy);

  // Parse proxy string
  const [host, port, username, password] = proxy.split(':');
  return {
    host,
    port,
    username,
    password,
  };
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
  try {
    // Use a flag on the page object to track interception status
    if (page._requestInterceptionEnabled) {
      return;
    }

    await page.setRequestInterception(true);
    page._requestInterceptionEnabled = true;

    page.on('request', request => {
      try {
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
      } catch (error) {
        // If request is already handled, just log it and continue
        if (error.message.includes('Request is already handled')) {
          console.log('Request already handled, continuing...');
        } else {
          console.error('Error handling request:', error);
          try {
            request.abort();
          } catch (abortError) {
            console.error('Error aborting request:', abortError);
          }
        }
      }
    });
  } catch (error) {
    console.error('Error setting up request interception:', error);
    throw error;
  }
}

// Add this new function to handle proxy authentication
async function setupProxyAuth(page, proxy) {
  if (proxy && proxy.username && proxy.password) {
    await page.authenticate({
      username: proxy.username,
      password: proxy.password,
    });
  }
}

// Modify initializeBrowser to store current proxy
async function initializeBrowser() {
  if (!browser) {
    const proxy = getNextProxy();
    const launchOptions = {
      headless: false,
      defaultViewport: null,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    };

    if (proxy) {
      launchOptions.args.push(`--proxy-server=${proxy.host}:${proxy.port}`);
    }

    browser = await puppeteer.launch(launchOptions);

    // Store the current proxy on the browser instance
    browser._currentProxy = proxy;

    // Set up proxy authentication for all initial pages
    const pages = await browser.pages();
    for (const page of pages) {
      await setupProxyAuth(page, proxy);
    }

    // Add listener for new pages
    browser.on('targetcreated', async target => {
      if (target.type() === 'page') {
        const page = await target.page();
        await setupProxyAuth(page, browser._currentProxy);
      }
    });
  }
  return browser;
}

function extractSecurityScoreData(project) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Skip projects with null/undefined id
  if (!project.id) {
    return null;
  }

  return {
    projectId: project.id,
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
    fetchedAt: today,
    updateTimestamp: new Date(),
  };
}

function extractMarketData(project) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Skip projects with null/undefined id
  if (!project.id) {
    return null;
  }

  return {
    projectId: project.id,
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
    fetchedAt: today,
    updateTimestamp: new Date(),
  };
}

async function handleFailedRanges(failedRanges) {
  console.log('Handling failed ranges:', failedRanges);

  for (const range of failedRanges) {
    let retryCount = 0;
    while (retryCount < MAX_RETRIES) {
      try {
        console.log(`Retrying range ${range.startSkip}-${range.endSkip} (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await fetchRangeData(range);
        console.log(`Successfully recovered range ${range.startSkip}-${range.endSkip}`);
        break;
      } catch (error) {
        retryCount++;
        if (retryCount === MAX_RETRIES) {
          console.error(`Failed to recover range ${range.startSkip}-${range.endSkip} after ${MAX_RETRIES} attempts`);
        }
        await new Promise(resolve => setTimeout(resolve, DELAY_ON_RETRY.MAX * retryCount));
      }
    }
  }
}

async function fetchRangeData({ startSkip, endSkip, limit, pageIndex, collectionName }) {
  let page = null;

  try {
    page = await browser.newPage();
    // Remove the proxy authentication here since it's handled by the browser event listener
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

    // Increased initial wait time to ensure stable session
    await new Promise(resolve => setTimeout(resolve, DELAY_INITIAL_PAGE_LOAD));

    // Connect to MongoDB
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGO_URL);
      await mongoClient.connect();
    }
    const db = mongoClient.db();
    const collection = db.collection(collectionName);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let skip = startSkip; skip <= endSkip; skip += limit) {
      // Add delay between batches (10-25 seconds random delay)
      const delay =
        Math.floor(Math.random() * (DELAY_BETWEEN_BATCHES.MAX - DELAY_BETWEEN_BATCHES.MIN)) + DELAY_BETWEEN_BATCHES.MIN;
      await new Promise(resolve => setTimeout(resolve, delay));

      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount < maxRetries) {
        try {
          console.log(`Worker ${pageIndex + 1} fetching skip=${skip} (after ${delay}ms delay)`);
          const response = await page.evaluate(
            async ({ skip, limit }) => {
              const res = await fetch(
                `https://skynet.certik.com/api/leaderboard-all-projects/query-leaderboard-projects?isClientOnly=false&limit=${limit}&order=DESC&skip=${skip}&sortBy=SECURITY_SCORE`,
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
          const projectsWithMetadata = response.items
            .map(project =>
              collectionName === SECURITY_SCORES_COLLECTION
                ? extractSecurityScoreData(project)
                : extractMarketData(project),
            )
            .filter(project => project !== null); // Filter out null projects

          // Modified bulk operations
          const bulkOps = projectsWithMetadata.map(project => ({
            updateOne: {
              filter: {
                projectId: project.projectId,
                fetchedAt: project.fetchedAt,
              },
              update: {
                $set: {
                  ...project,
                  updateTimestamp: new Date(),
                  updateCount: { $inc: 1 },
                },
              },
              upsert: true,
            },
          }));

          if (bulkOps.length > 0) {
            await collection.bulkWrite(bulkOps);
          }

          console.log(`Worker ${pageIndex + 1} processed skip=${skip}, items=${bulkOps.length}`);
          break; // Success, exit retry loop
        } catch (error) {
          retryCount++;
          if (retryCount === maxRetries) throw error;
          console.log(`Retry ${retryCount}/${maxRetries} for skip=${skip}`);
          // Increase delay on retry (10-25 seconds)
          const retryDelay = Math.floor(Math.random() * (DELAY_ON_RETRY.MAX - DELAY_ON_RETRY.MIN)) + DELAY_ON_RETRY.MIN;
          console.log(`Waiting ${retryDelay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
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
      await db.collection(SECURITY_SCORES_COLLECTION).createIndex({ projectId: 1, fetchedAt: 1 }, { unique: true });
      console.log(`Created new index for: ${SECURITY_SCORES_COLLECTION}`);
    }

    // Handle market data collection
    if (!collectionNames.includes(MARKET_DATA_COLLECTION)) {
      await db.createCollection(MARKET_DATA_COLLECTION);
      console.log(`Created collection: ${MARKET_DATA_COLLECTION}`);
      // Create new compound index
      await db.collection(MARKET_DATA_COLLECTION).createIndex({ projectId: 1, fetchedAt: 1 }, { unique: true });
      console.log(`Created new index for: ${MARKET_DATA_COLLECTION}`);
    }
  } catch (error) {
    console.error('Error ensuring collections:', error);
    throw error;
  }
}

async function crawlData(collectionName) {
  try {
    await ensureCollections();

    browser = await initializeBrowser();
    const page = await browser.newPage();

    await setupRequestInterception(page);

    // Add timeout and more flexible navigation options
    try {
      await page.goto('https://skynet.certik.com/leaderboards/security', {
        waitUntil: ['domcontentloaded', 'networkidle2'],
        timeout: 30000, // 30 seconds timeout
      });
    } catch (navigationError) {
      console.warn('Navigation timeout, but continuing...', navigationError.message);
      // Continue execution even if navigation timeout occurs
    }

    const currentCookies = await page.cookies();
    await saveCookies(currentCookies);

    // Add explicit wait for API readiness
    await new Promise(resolve => setTimeout(resolve, DELAY_API_READINESS));

    // Get total items using the same page
    const initialResponse = await page.evaluate(async () => {
      // Increased wait time for page stability
      await new Promise(resolve => setTimeout(resolve, 3000));

      try {
        const res = await fetch(
          'https://skynet.certik.com/api/leaderboard-all-projects/query-leaderboard-projects?isClientOnly=false&limit=30&order=ASC&skip=0&sortBy=SECURITY_SCORE',
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
      } catch (fetchError) {
        console.error('Error fetching initial data:', fetchError);
        throw fetchError;
      }
    });

    await page.close();

    const totalItems = !!MAX_TOPS_PROJECTS ? MAX_TOPS_PROJECTS : initialResponse.page.total;

    console.log(
      `Total items to fetch: ${totalItems} ${MAX_TOPS_PROJECTS ? `(limited from ${initialResponse.page.total})` : ''}`,
    );

    // Calculate ranges for workers - now using MAX_THREADS
    const limit = BATCH_SIZE;
    const numTabs = Math.min(MAX_THREADS, Math.ceil(totalItems / limit));
    const itemsPerTab = Math.ceil(totalItems / numTabs);

    console.log(`Using ${numTabs} threads to process ${totalItems} items`);

    const tabPromises = [];
    const ranges = [];

    // Create and start tabs
    for (let i = 0; i < numTabs; i++) {
      const startSkip = i * itemsPerTab;
      const endSkip = Math.min((i + 1) * itemsPerTab - 1, totalItems - 1);

      const range = {
        startSkip,
        endSkip,
        limit,
        pageIndex: i,
        collectionName,
      };
      ranges.push(range);

      console.log(`Starting tab ${i + 1}/${numTabs} for range ${startSkip}-${endSkip}`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_TABS));
      tabPromises.push(fetchRangeData(range));
    }

    // Wait for all tabs and handle failures
    const results = await Promise.allSettled(tabPromises);
    const failedRanges = ranges.filter((range, index) => results[index].status === 'rejected');

    if (failedRanges.length > 0) {
      console.log(`${failedRanges.length} ranges failed, attempting recovery...`);
      await handleFailedRanges(failedRanges);
    }

    console.log('All tabs completed');
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

// Add new function to run both crawlers sequentially
async function runBothCrawlers() {
  try {
    console.log('Starting market data crawler...');
    await handleMarketDataSchedule();

    const delayMinutes = DELAY_BETWEEN_CRAWLERS / (60 * 1000);
    console.log(
      `Security score crawler completed. Waiting ${delayMinutes} minutes before starting market data crawler...`,
    );

    // Wait between crawlers
    await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_CRAWLERS));

    console.log('Starting security score crawler...');
    await handleSecurityScoreSchedule();

    console.log('Both crawlers completed. Setting up scheduled jobs...');
  } catch (error) {
    console.error('Error running crawlers:', error);
  }
}

// Modify the command line argument handling
const args = process.argv.slice(2);

if (args[0] === 'security') {
  handleSecurityScoreSchedule();
} else if (args[0] === 'market') {
  handleMarketDataSchedule();
} else if (args[0] === 'dev') {
  // Development mode - run both crawlers with delay
  console.log('Running in development mode...');
  console.log('Starting market data crawler...');
  handleMarketDataSchedule().then(() => {
    const delayMinutes = DELAY_BETWEEN_CRAWLERS / (60 * 1000);
    console.log(
      `Market data crawler completed. Waiting ${delayMinutes} minutes before starting security score crawler...`,
    );
    setTimeout(handleSecurityScoreSchedule, DELAY_BETWEEN_CRAWLERS);
  });
} else {
  // Production mode - run both crawlers first, then set up scheduled jobs
  console.log('Starting in production mode...');

  // Run both crawlers sequentially first
  runBothCrawlers().then(() => {
    console.log('Setting up scheduled crawlers...');

    // Schedule market data crawler to run daily at 00:00 UTC
    cron.schedule(
      '0 0 * * *',
      async () => {
        console.log('Running scheduled market data crawler...');
        await handleMarketDataSchedule();

        // Only run security score crawler on Sundays
        if (new Date().getDay() === 0) {
          const delayMinutes = DELAY_BETWEEN_CRAWLERS / (60 * 1000);
          console.log(`Waiting ${delayMinutes} minutes before running security score crawler...`);

          setTimeout(async () => {
            console.log('Running scheduled security score crawler...');
            await handleSecurityScoreSchedule();
          }, DELAY_BETWEEN_CRAWLERS);
        }
      },
      {
        timezone: 'UTC',
      },
    );

    console.log('Crawlers scheduled (all times in UTC):');
    console.log('- Market Data: Daily at 00:00 UTC');
    console.log('- Security Scores: Every Sunday after market data crawler completes');
  });
}

// Keep the process running
process.stdin.resume();
