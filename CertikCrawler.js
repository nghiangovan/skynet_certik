const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { MongoClient } = require('mongodb');
const os = require('os');

class CertikCrawler {
  constructor(config = {}) {
    // Configuration
    this.mongoUrl = config.mongoUrl || 'mongodb://localhost:27017/crypto_db';
    this.securityScoresCollection = config.securityScoresCollection || 'security_scores';
    this.marketDataCollection = config.marketDataCollection || 'market_data';
    this.maxThreads = config.maxThreads || Math.max(os.cpus().length - 2, 1);
    this.maxTopsProjects = config.maxTopsProjects || null;
    this.proxies = config.proxies || [];

    // State
    this.browser = null;
    this.mongoClient = null;

    // Constants
    this.BATCH_SIZE = 50;
    this.MAX_RETRIES = 3;
    this.DELAY = {
      DEFAULT_NAVIGATION_TIMEOUT: 50 * 1000,
      TIMEOUT_INITIAL_PAGE_LOAD: 50 * 1000,
      INITIAL_PAGE_LOAD: 20 * 1000,
      BETWEEN_BATCHES: {
        MIN: 15 * 1000,
        MAX: 25 * 1000,
      },
      ON_RETRY: {
        MIN: 15 * 1000,
        MAX: 25 * 1000,
      },
      BETWEEN_TABS: 1000,
      API_READINESS: 3000,
    };
  }

  getNextProxy() {
    if (!this.proxies.length) return null;

    // Rotate through proxies
    const proxy = this.proxies.shift();
    this.proxies.push(proxy);

    // Parse proxy string if it's a string, otherwise use as is
    if (typeof proxy === 'string') {
      const [host, port, username, password] = proxy.split(':');
      return {
        host,
        port,
        username,
        password,
      };
    }

    // If proxy is already an object, return as is
    return proxy;
  }

  async saveCookies(cookies) {
    await fs.writeFile(path.join(__dirname, 'cookies.json'), JSON.stringify(cookies, null, 2));
  }

  async loadCookies() {
    try {
      const cookiesString = await fs.readFile(path.join(__dirname, 'cookies.json'), 'utf-8');
      return JSON.parse(cookiesString);
    } catch (error) {
      return [];
    }
  }

  async setupRequestInterception(page) {
    try {
      if (page._requestInterceptionEnabled) return;

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
          if (!error.message.includes('Request is already handled')) {
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

  async setupProxyAuth(page, proxy) {
    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }
  }

  async initializeBrowser() {
    if (!this.browser) {
      const proxy = this.getNextProxy();
      const launchOptions = {
        headless: false,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920x1080',
        ],
        ignoreHTTPSErrors: true,
      };

      if (proxy) {
        launchOptions.args.push(`--proxy-server=${proxy.host}:${proxy.port}`);
      }

      this.browser = await puppeteer.launch(launchOptions);

      // Store the current proxy on the browser instance
      this.browser._currentProxy = proxy;

      // Set up proxy authentication for all initial pages
      const pages = await this.browser.pages();
      for (const page of pages) {
        await this.setupProxyAuth(page, proxy);
      }

      // Add listener for new pages
      this.browser.on('targetcreated', async target => {
        if (target.type() === 'page') {
          const page = await target.page();
          await this.setupProxyAuth(page, this.browser._currentProxy);
        }
      });
    }
    return this.browser;
  }

  async ensureMongoConnection() {
    if (!this.mongoClient) {
      this.mongoClient = new MongoClient(this.mongoUrl);
      await this.mongoClient.connect();
    }
    return this.mongoClient;
  }

  async ensureCollections() {
    try {
      const client = await this.ensureMongoConnection();
      const db = client.db();
      const collections = await db.listCollections().toArray();
      const collectionNames = collections.map(col => col.name);

      for (const collectionName of [this.securityScoresCollection, this.marketDataCollection]) {
        if (!collectionNames.includes(collectionName)) {
          await db.createCollection(collectionName);
          console.log(`Created collection: ${collectionName}`);
          await db.collection(collectionName).createIndex({ projectId: 1, fetchedAt: 1 }, { unique: true });
          console.log(`Created index for: ${collectionName}`);
        }
      }
    } catch (error) {
      console.error('Error ensuring collections:', error);
      throw error;
    }
  }

  async getTotalItems(page) {
    const initialResponse = await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const res = await fetch(
        'https://skynet.certik.com/api/leaderboard-all-projects/query-leaderboard-projects?isClientOnly=false&limit=30&order=DESC&skip=0&sortBy=SECURITY_SCORE',
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
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      return await res.json();
    });

    return initialResponse.page.total;
  }

  calculateRanges(numTabs, itemsPerTab, totalItems, collectionName) {
    const ranges = [];
    for (let i = 0; i < numTabs; i++) {
      const startSkip = i * itemsPerTab;
      const endSkip = Math.min((i + 1) * itemsPerTab - 1, totalItems - 1);
      ranges.push({
        startSkip,
        endSkip,
        limit: this.BATCH_SIZE,
        pageIndex: i,
        collectionName,
      });
    }
    return ranges;
  }

  async processRanges(ranges) {
    const tabPromises = ranges.map(range => this.fetchRangeData(range));
    const results = await Promise.allSettled(tabPromises);

    const failedRanges = ranges.filter((range, index) => results[index].status === 'rejected');
    if (failedRanges.length > 0) {
      console.log(`${failedRanges.length} ranges failed, attempting recovery...`);
      await this.handleFailedRanges(failedRanges);
    }
  }

  async fetchRangeData({ startSkip, endSkip, limit, pageIndex, collectionName }) {
    let page = null;

    try {
      page = await this.browser.newPage();
      await page.setDefaultNavigationTimeout(this.DELAY.DEFAULT_NAVIGATION_TIMEOUT);

      const cookies = await this.loadCookies();
      if (cookies.length) {
        await page.setCookie(...cookies);
      }

      await this.setupRequestInterception(page);

      await page.goto('https://skynet.certik.com/leaderboards/security', {
        waitUntil: 'networkidle0',
        timeout: this.DELAY.TIMEOUT_INITIAL_PAGE_LOAD,
      });

      await new Promise(resolve => setTimeout(resolve, this.DELAY.INITIAL_PAGE_LOAD));

      const client = await this.ensureMongoConnection();
      const db = client.db();

      // Handle both single collection and array of collections
      const collection = Array.isArray(collectionName)
        ? collectionName // If it's already an array of collections, use as is
        : db.collection(collectionName); // If it's a string, get the collection

      for (let skip = startSkip; skip <= endSkip; skip += limit) {
        const delay =
          Math.floor(Math.random() * (this.DELAY.BETWEEN_BATCHES.MAX - this.DELAY.BETWEEN_BATCHES.MIN)) +
          this.DELAY.BETWEEN_BATCHES.MIN;
        await new Promise(resolve => setTimeout(resolve, delay));

        let retryCount = 0;
        while (retryCount < this.MAX_RETRIES) {
          try {
            console.log(`Worker ${pageIndex + 1} fetching skip=${skip} (after ${delay}ms delay)`);
            const response = await this.fetchBatchData(page, skip, limit);

            // Handle synchronized collections
            if (Array.isArray(collection)) {
              await this.saveBatchToMongoSynchronized(response, collection);
            } else {
              await this.saveBatchToMongo(response, collection);
            }
            break;
          } catch (error) {
            retryCount++;
            if (retryCount === this.MAX_RETRIES) throw error;
            console.log(`Retry ${retryCount}/${this.MAX_RETRIES} for skip=${skip}`);
            const retryDelay =
              Math.floor(Math.random() * (this.DELAY.ON_RETRY.MAX - this.DELAY.ON_RETRY.MIN)) + this.DELAY.ON_RETRY.MIN;
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

  async fetchBatchData(page, skip, limit) {
    return await page.evaluate(
      async ({ skip, limit }) => {
        const res = await fetch(
          `https://skynet.certik.com/api/leaderboard-all-projects/query-leaderboard-projects?isClientOnly=false&limit=${limit}&order=ASC&skip=${skip}&sortBy=SECURITY_SCORE`,
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
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return await res.json();
      },
      { skip, limit },
    );
  }

  extractSecurityScoreData(project) {
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

  extractMarketData(project) {
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

  async saveBatchToMongo(response, collection) {
    if (!response || !response.items) {
      throw new Error('Invalid response');
    }

    // Extract data based on collection type
    const projectsWithMetadata = response.items
      .map(project =>
        collection.collectionName === this.securityScoresCollection
          ? this.extractSecurityScoreData(project)
          : this.extractMarketData(project),
      )
      .filter(project => project !== null); // Filter out null projects

    const bulkOps = projectsWithMetadata.map(project => ({
      updateOne: {
        filter: {
          projectId: project.projectId,
          fetchedAt: project.fetchedAt,
        },
        update: {
          $set: project,
          $inc: { updateCount: 1 },
        },
        upsert: true,
      },
    }));

    if (bulkOps.length > 0) {
      const result = await collection.bulkWrite(bulkOps);
      console.log(`Processed ${result.upsertedCount} new projects, modified ${result.modifiedCount} existing projects`);
    }
  }

  async saveBatchToMongoSynchronized(response, collections) {
    if (!response || !response.items) {
      throw new Error('Invalid response');
    }

    for (const collection of collections) {
      const projectsWithMetadata = response.items
        .map(project =>
          collection.collectionName === this.securityScoresCollection
            ? this.extractSecurityScoreData(project)
            : this.extractMarketData(project),
        )
        .filter(project => project !== null);

      const bulkOps = projectsWithMetadata.map(project => ({
        updateOne: {
          filter: {
            projectId: project.projectId,
            fetchedAt: project.fetchedAt,
          },
          update: {
            $set: project,
            $inc: { updateCount: 1 },
          },
          upsert: true,
        },
      }));

      if (bulkOps.length > 0) {
        const result = await collection.bulkWrite(bulkOps);
        console.log(
          `[${collection.collectionName}] Processed ${result.upsertedCount} new projects, modified ${result.modifiedCount} existing projects`,
        );
      }
    }
  }

  async handleFailedRanges(failedRanges) {
    for (const range of failedRanges) {
      let retryCount = 0;
      while (retryCount < this.MAX_RETRIES) {
        try {
          await this.fetchRangeData(range);
          break;
        } catch (error) {
          retryCount++;
          if (retryCount === this.MAX_RETRIES) {
            console.error(`Failed to recover range ${range.startSkip}-${range.endSkip}`);
          }
          await new Promise(resolve => setTimeout(resolve, this.DELAY.ON_RETRY.MAX * retryCount));
        }
      }
    }
  }

  async crawlData(collectionNames, options = { synchronized: false }) {
    try {
      await this.ensureCollections();
      this.browser = await this.initializeBrowser();
      const page = await this.browser.newPage();
      await this.setupRequestInterception(page);

      await page.goto('https://skynet.certik.com/leaderboards/security', {
        waitUntil: ['domcontentloaded', 'networkidle2'],
        timeout: 30000,
      });

      const currentCookies = await page.cookies();
      await this.saveCookies(currentCookies);
      await new Promise(resolve => setTimeout(resolve, this.DELAY.API_READINESS));

      const totalItems = this.maxTopsProjects || (await this.getTotalItems(page));
      await page.close();

      const numTabs = Math.min(this.maxThreads, Math.ceil(totalItems / this.BATCH_SIZE));
      const itemsPerTab = Math.ceil(totalItems / numTabs);

      if (options.synchronized && Array.isArray(collectionNames)) {
        // Handle synchronized collection
        const client = await this.ensureMongoConnection();
        const db = client.db();
        const collections = collectionNames.map(name => db.collection(name));

        const ranges = this.calculateRanges(numTabs, itemsPerTab, totalItems, collections);
        console.log(
          `Using ${numTabs} threads to process ${totalItems} items synchronously for ${collectionNames.length} collections`,
        );
        await this.processRanges(ranges);
      } else {
        // Handle single collection
        const ranges = this.calculateRanges(numTabs, itemsPerTab, totalItems, collectionNames);
        console.log(`Using ${numTabs} threads to process ${totalItems} items for collection: ${collectionNames}`);
        await this.processRanges(ranges);
      }
    } catch (error) {
      console.error('An error occurred:', error);
      throw error;
    } finally {
      await this.close();
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.mongoClient) {
      await this.mongoClient.close();
      this.mongoClient = null;
    }
  }
}

module.exports = CertikCrawler;
