# Certik Skynet Crawler

A Node.js application that crawls and stores security scores and market data from Certik Skynet's leaderboards. Features synchronized data collection for both security scores and market data.

## Features

- **Advanced Crawling**

  - Multi-threaded data collection
  - Automatic CPU core optimization
  - Smart batch processing
  - Configurable thread limits

- **Synchronized Collection**

  - Combined security scores and market data crawling
  - Independent collection mode
  - Automatic data synchronization
  - Efficient resource utilization

- **Intelligent Scheduling**

  - Daily market data updates
  - Weekly synchronized security scores
  - Configurable scheduling patterns
  - UTC timezone alignment

- **Robust Error Handling**
  - Automatic retry mechanism
  - Rate limit management
  - Failed range recovery
  - Session persistence

## Prerequisites

- Node.js (v16 or higher)
- MongoDB
- Yarn (preferred)
- Puppeteer-compatible environment

## Installation

### As a Standalone Application

1. Clone the repository:

```bash
git clone <repository-url>
cd skynet_certik
```

2. Install dependencies:

```bash
yarn install
```

3. Configure environment variables:

```bash
cp .env.example .env
```

### Environment Configuration

```env
# MongoDB Connection
MONGO_URL=mongodb://localhost:27017/certik_db

# Collection Names
SECURITY_SCORES_COLLECTION=security_scores
MARKET_DATA_COLLECTION=market_data

# Performance Settings
MAX_THREADS=4
MAX_TOPS_PROJECTS=100

# Optional Proxy Configuration
PROXIES='["HOST:PORT:USER:PASS"]'
```

## Usage

### Basic Implementation

```javascript
const CertikCrawler = require('./CertikCrawler');

const crawler = new CertikCrawler({
  mongoUrl: process.env.MONGO_URL,
  securityScoresCollection: process.env.SECURITY_SCORES_COLLECTION,
  marketDataCollection: process.env.MARKET_DATA_COLLECTION,
  maxThreads: 4,
  maxTopsProjects: 100,
});

// Single collection crawl
await crawler.crawlData(config.marketDataCollection);

// Synchronized crawl
await crawler.crawlData([config.securityScoresCollection, config.marketDataCollection], { synchronized: true });
```

### Scheduling Examples

```javascript
const cron = require('node-cron');

// Daily market data collection
cron.schedule(
  '0 0 * * *',
  async () => {
    if (new Date().getDay() === 0) {
      // Sunday: synchronized collection
      await crawler.crawlData([config.securityScoresCollection, config.marketDataCollection], { synchronized: true });
    } else {
      // Other days: market data only
      await crawler.crawlData(config.marketDataCollection);
    }
  },
  {
    timezone: 'UTC',
  },
);
```

## Data Collections

### Security Scores

```javascript
{
  projectId: String,
  name: String,
  securityScoreV3: Object,
  audits: Array,
  has3rdPartyAudit: Boolean,
  badges: Array,
  kycAssessment: Object,
  fetchedAt: Date,
  updateTimestamp: Date
}
```

### Market Data

```javascript
{
  projectId: String,
  name: String,
  marketCap: Number,
  price: Number,
  tradingVolume: Number,
  percentChangeInPrice: Number,
  fetchedAt: Date,
  updateTimestamp: Date
}
```

## Performance Tuning

### Delay Configuration

```javascript
DELAY = {
  BETWEEN_CRAWLERS: 30 * 60 * 1000, // 30 minutes
  INITIAL_PAGE_LOAD: 30 * 1000, // 30 seconds
  BETWEEN_BATCHES: {
    MIN: 30 * 1000, // 30 seconds
    MAX: 40 * 1000, // 40 seconds
  },
  ON_RETRY: {
    MIN: 30 * 1000,
    MAX: 40 * 1000,
  },
};
```

### Thread Management

- Default: CPU cores - 2
- Configurable via MAX_THREADS
- Automatic batch size optimization
- Smart resource allocation

## Error Handling

### Retry Mechanism

- Maximum 3 retry attempts
- Exponential backoff
- Random delay intervals
- Failed range recovery

### Session Management

- Cookie persistence
- Automatic session recovery
- Request interception
- Header management

## Development

### Debug Mode

```bash
# Start with visual debugging
yarn dev

# Debug specific crawler
yarn security  # Security scores only
yarn market    # Market data only
```

### Testing

```bash
# Test synchronized collection
node testUseCertikCrawler.js
```

## Troubleshooting

### Common Issues

1. **Rate Limiting**

   - Increase delay values
   - Reduce thread count
   - Implement proxy rotation

2. **Browser Issues**

   - Clear cookies.json
   - Check Puppeteer compatibility
   - Verify proxy settings

3. **MongoDB Errors**
   - Verify connection string
   - Check collection names
   - Ensure proper indexes

### Logging

The crawler provides detailed logging for:

- Worker status
- Batch processing
- Retry attempts
- Database operations

## Contributing

1. Fork the repository
2. Create your feature branch
3. Implement changes
4. Add/update tests
5. Submit pull request

## License

[Your License]

## Support

For issues and feature requests, please open an issue in the repository.
