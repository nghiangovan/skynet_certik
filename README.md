# Certik Skynet Crawler

A Node.js application that crawls and stores security scores and market data from Certik Skynet's leaderboards.

## Features

- Multi-threaded crawling with automatic CPU core optimization
- Scheduled data collection (daily market data and weekly security scores)
- Rate limit handling with smart delays
- MongoDB storage with compound indexing
- Automatic retry mechanism for failed requests
- Development and production modes
- Cookie persistence for session management

## Prerequisites

- Node.js (v16 or higher)
- MongoDB
- Yarn or NPM

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd certik-crawler
```

2. Install dependencies:

```bash
yarn install
# or
npm install
```

3. Configure environment variables:

```bash
cp .env.example .env
```

4. Update `.env` with your settings:

```env
# MongoDB Connection
MONGO_URL=mongodb://localhost:27017/certik_db

# Collection Names
SECURITY_SCORES_COLLECTION=security_scores
MARKET_DATA_COLLECTION=market_data
```

## Usage

### Production Mode

```bash
yarn start
# or
npm start
```

This will:

1. Run market data crawler immediately
2. Wait 10 minutes
3. Run security scores crawler
4. Set up scheduled jobs:
   - Market Data: Daily at 00:00 UTC
   - Security Scores: Weekly on Sunday at 00:30 UTC

### Development Mode

```bash
yarn dev
# or
npm run dev
```

Runs both crawlers sequentially with delays for testing.

### Individual Crawlers

```bash
# Run security scores crawler only
yarn security
# or
npm run security

# Run market data crawler only
yarn market
# or
npm run market
```

## Data Structure

### Security Scores Collection

```javascript
{
  projectId: String,
  audits: Array,
  has3rdPartyAudit: Boolean,
  badges: Array,
  kycAssessment: Object,
  labels: Array,
  contentfulLogo: String,
  contentfulDarkModeLogo: String,
  name: String,
  securityScoreV3: Object,
  selfReportedMarketCap: Number,
  projectTokenStatus: String,
  newSecurityScore: Object,
  fetchedAt: Date,
  updateTimestamp: Date,
  updateCount: Number
}
```

### Market Data Collection

```javascript
{
  projectId: String,
  labels: Array,
  marketCap: Number,
  marketCapType: String,
  name: String,
  onboardedAt: Date,
  percentChangeInPrice: Number,
  previousPrice: Number,
  price: Number,
  selfReportedMarketCap: Number,
  projectTokenStatus: String,
  tradingVolume: Number,
  previousTradingVolume: Number,
  fetchedAt: Date,
  updateTimestamp: Date,
  updateCount: Number
}
```

## Configuration

### Constants

- `MAX_THREADS`: Number of concurrent crawlers (CPU cores - 2)
- `BATCH_SIZE`: Number of items per request (50)
- `MAX_RETRIES`: Maximum retry attempts for failed requests (3)
- `DELAY_BETWEEN_CRAWLERS`: Delay between crawlers (10 minutes)

### MongoDB Indexes

Both collections use compound unique indexes:

```javascript
{ projectId: 1, fetchedAt: 1 }
```

## Error Handling

### Rate Limiting

- Random delays between requests (10-30 seconds)
- Increased delays on retry attempts (10-20 seconds)
- 10-minute delay between crawlers
- Session persistence using cookies

### Retry Mechanism

- Maximum 3 retry attempts per request
- Exponential backoff with random delays
- Failed ranges recovery system

### Data Validation

- Null/undefined project ID filtering
- Response validation
- Duplicate prevention using compound indexes

## Development

### Browser Configuration

```javascript
browser = await puppeteer.launch({
  headless: false, // Visual debugging
  defaultViewport: null,
});
```

### Request Interception

Custom headers for all API requests:

```javascript
{
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'priority': 'u=1, i',
  'referer': 'https://skynet.certik.com/leaderboards/security'
}
```

## Troubleshooting

1. **Rate Limiting Issues**

   - Increase `DELAY_BETWEEN_CRAWLERS`
   - Adjust random delay ranges
   - Reduce `MAX_THREADS`

2. **MongoDB Errors**

   - Check MongoDB connection string
   - Verify database permissions
   - Ensure indexes are properly created

3. **Browser Issues**

   - Delete `cookies.json` to reset session
   - Check for Puppeteer compatibility
   - Verify network connectivity

## License

[Your License]

## Contributing

[Your Contributing Guidelines]
