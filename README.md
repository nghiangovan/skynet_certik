# Certik Crawler

A Node.js-based web crawler that collects security scores and market data from Certik Skynet's leaderboard.

## Features

- Crawls Certik Skynet's leaderboard for security scores and market data
- Multi-threaded crawling using multiple browser tabs
- Automatic data storage in MongoDB
- Scheduled crawling with configurable intervals
- Error handling and retry mechanisms
- Cookie persistence for session management

## Prerequisites

- Node.js (v14 or higher recommended)
- MongoDB instance
- NPM or Yarn package manager

## Installation

1. Clone the repository:

```bash
git clone <repository-url>
cd certik-crawler
```

2. Install dependencies:

```bash
npm install
```

3. Create a `.env` file in the project root with the following variables:

```
MONGO_URL=<your-mongodb-connection-string>
SECURITY_SCORES_COLLECTION=security_scores
MARKET_DATA_COLLECTION=market_data
```

## Usage

The crawler can be run in several modes:

### Production Mode

```bash
npm start
```

This will start the crawler with scheduled tasks:

- Security Scores: Runs every Sunday at 00:30 UTC
- Market Data: Runs daily at 00:00 UTC

### Development Mode

```bash
npm run dev
```

This will immediately run both crawlers in sequence for testing purposes.

### Individual Crawlers

Run security scores crawler:

```bash
npm run security
```

Run market data crawler:

```bash
npm run market
```

## Data Structure

### Security Scores Collection

```javascript
{
  _id: String,
  id: String,
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
  firstFetchedAt: Date
}
```

### Market Data Collection

```javascript
{
  _id: String,
  id: String,
  labels: Array,
  marketCap: Number,
  marketCapType: String,
  name: String,
  onboardedAt: String,
  percentChangeInPrice: Number,
  previousPrice: Number,
  price: Number,
  selfReportedMarketCap: Number,
  projectTokenStatus: String,
  tradingVolume: Number,
  previousTradingVolume: Number,
  fetchedAt: Date,
  updateTimestamp: Date,
  firstFetchedAt: Date
}
```

## Technical Details

### Performance Optimization

- Uses multiple browser tabs for parallel crawling
- Number of tabs is automatically adjusted based on CPU cores (max 4)
- Implements request interception for optimized network requests
- Includes retry mechanism for failed requests

### MongoDB Indexing

The crawler automatically creates the following indexes:

Security Scores Collection:

- `id`: unique index
- `fetchedAt`
- `securityScoreV3.rank`
- `newSecurityScore.rank`

Market Data Collection:

- `id`: unique index
- `fetchedAt`
- `marketCap`: descending
- `tradingVolume`: descending

## Error Handling

The crawler implements several error handling mechanisms:

- Automatic retries for failed requests (max 3 attempts)
- Session management with cookie persistence
- Graceful shutdown on process termination
- Error logging for failed crawl attempts

## Maintenance

### Cookie Management

Cookies are automatically saved to `cookies.json` and loaded for subsequent runs. If you experience authentication issues, you may need to delete this file to force a new session.

### MongoDB Connection

The crawler will automatically create required collections and indexes if they don't exist. Ensure your MongoDB instance has adequate storage space for historical data.

## Troubleshooting

Common issues and solutions:

1. **Connection Errors**

   - Verify MongoDB connection string in `.env`
   - Check if MongoDB instance is running
   - Ensure network connectivity to MongoDB server

2. **Crawling Errors**

   - Delete `cookies.json` to reset session
   - Check console logs for specific error messages
   - Verify network connectivity to Certik Skynet

3. **Performance Issues**
   - Reduce number of concurrent tabs
   - Increase delay between requests
   - Check system resources (CPU, memory)
