# Real-Time Crypto Price Streaming Analytics Platform

## 1. Purpose and scope

This project is a small event-driven data platform for tracking cryptocurrency prices. It collects live ticker messages from Coinbase, transports them through Apache Kafka, processes and stores them in MongoDB, and exposes the stored data through a REST API for a React dashboard.

The application currently subscribes to three Coinbase products:

- `BTC-USD`
- `ETH-USD`
- `SOL-USD`

The platform demonstrates a streaming pipeline, asynchronous service boundaries, persistence, basic market analytics, threshold alerts, and a browser-based dashboard. It is an educational/demo application rather than a trading system: it does not place trades, guarantee delivery of every market event, or provide financial advice.

## 2. Architecture at a glance

```text
Coinbase ticker WebSocket
            |
            v
Producer (Node.js + ws + KafkaJS)
            |
            v
Kafka topic: crypto-prices
            |
            v
Consumer (KafkaJS)
    |                 |
    |                 +--> In-memory, per-symbol alert history
    v
MongoDB: crypto_analytics
    |
    v
Express REST API
    |
    v
React + Vite dashboard
```

The producer, consumer, API, and frontend are independent processes. Docker Compose provides the supporting infrastructure—ZooKeeper, Kafka, and MongoDB—but does not start the Node.js applications.

## 3. End-to-end event lifecycle

### 3.1 Ingestion from Coinbase

`producer/src/coinbaseClient.js` opens a WebSocket connection to Coinbase and subscribes to the `ticker` channel for the configured product IDs. It ignores non-ticker messages and messages missing a product ID, price, or timestamp.

A Coinbase ticker is normalized to this application event shape:

```json
{
  "symbol": "BTC-USD",
  "price": 75791.89,
  "timestamp": "2026-11-07T00:04:00.000Z"
}
```

`price` is converted from Coinbase's string value to a JavaScript number. `timestamp` is the event timestamp supplied by Coinbase, not the time the consumer receives it.

### 3.2 Publishing to Kafka

`producer/src/kafkaProducer.js` serializes each normalized event as JSON and publishes it to the configured Kafka topic. Kafka separates the market-data connection from downstream processing: the consumer can read events independently of the WebSocket client.

The default topic is `crypto-prices`. The KafkaJS producer currently sends messages without an explicit Kafka key.

### 3.3 Processing in the consumer

`consumer/src/kafkaConsumer.js` connects to MongoDB and Kafka, subscribes as consumer group `crypto-analytics-group`, and processes messages from the topic. It:

1. Parses the JSON event.
2. Finds an eligible in-memory price baseline for alert calculations.
3. Inserts the raw event into `price_events`.
4. Enforces the per-symbol raw-event retention cap.
5. Reads recent raw events and computes the backend moving average.
6. Upserts the latest per-symbol snapshot in `metrics`.
7. Adds the current price to the in-memory alert history.
8. Creates an alert if the time-window change meets the threshold and the symbol is not on cooldown.

### 3.4 Persistence and API

The API connects to the same MongoDB database name and exposes read-only endpoints over the stored collections. The frontend calls the API to load metrics, alerts, and recent price history.

### 3.5 Dashboard refresh behavior

The dashboard loads data when it first opens, when the selected symbol changes, and when the user clicks **Refresh Data**. The browser does not currently receive streaming updates directly and there is no timed auto-refresh loop. Therefore, the ingestion and database pipeline can be processing live events while the displayed dashboard remains unchanged until the next fetch.

## 4. Services and implementation

### Producer

Main files:

- `producer/src/index.js` starts the Kafka producer, then the Coinbase WebSocket stream.
- `producer/src/coinbaseClient.js` subscribes to Coinbase, filters and normalizes ticker messages, and forwards them.
- `producer/src/kafkaProducer.js` owns the KafkaJS producer connection and message publication.
- `producer/src/config.js` provides broker, topic, WebSocket URL, and product settings.

On WebSocket closure the client schedules a reconnect after five seconds. Producer and consumer are separate processes so a network feed and analytics logic can be developed or operated independently.

### Kafka infrastructure

`docker-compose.yml` runs:

- ZooKeeper, for the configured Kafka broker's coordination.
- One Kafka broker, advertised to host applications at `localhost:9092` and to containers at `kafka:29092`.
- MongoDB 7, with data stored in the Compose-managed `mongo_data` volume and port `27017` exposed on the host.

The Compose setup is a local single-broker configuration. Its replication settings are appropriate for local development, not high availability.

### Consumer and analytics

Main files:

- `consumer/src/index.js` connects to MongoDB and starts the Kafka consumer.
- `consumer/src/kafkaConsumer.js` processes events and persists raw events, metrics, and alerts.
- `consumer/src/analytics.js` contains the arithmetic, alert construction, and live alert-history tracker.
- `consumer/src/config.js` contains the consumer's defaults and environment overrides.
- `consumer/src/mongoClient.js` manages the consumer's MongoDB connection.

The consumer uses `fromBeginning: false` when subscribing. For a consumer group with a committed offset, Kafka resumes from that group offset; the setting does not itself mean that every restart begins at the newest message.

### API server

The Express application is assembled in `api-server/src/app.js`; `api-server/src/index.js` connects to MongoDB before opening the HTTP listener. Routes are in `api-server/routes/`.

The API uses the native MongoDB driver and the same default database name as the consumer: `crypto_analytics`. It does not use Mongoose or a predefined SQL schema. Collections are created by MongoDB as documents are first inserted.

### Frontend

The Vite/React application uses React Router for the home, dashboard, documentation, and project-info pages. Recharts renders the price chart.

The dashboard requests metrics, the latest 10 alerts, and up to 10 history records for the selected symbol. Requests are made concurrently. A request sequence guard prevents an older response from overwriting the results of a newer selection or refresh, and fetch caching is disabled.

The API base URL is currently hard-coded as `http://localhost:5000/api` in `frontend/src/services/api.js`. A deployed frontend therefore needs a configurable API URL or a corresponding deployment/proxy setup.

## 5. Calculations

### 5.1 Backend moving average

For each processed ticker, the consumer queries the most recent `N` stored events for the same symbol, ordered by event timestamp descending, and computes their arithmetic mean:

```text
movingAverage = (price1 + price2 + ... + priceN) / numberOfPrices
```

The current default is `MOVING_AVERAGE_WINDOW=5`. The new raw event is inserted before this query, so with normally ordered event timestamps the current ticker is included among the sampled prices. If fewer than `N` events exist, the average uses the available events. The result is rounded to four decimal places before it is stored in `metrics`.

This is an event-count window, not a time-duration window. If ticker frequency changes, the amount of time represented by five events changes too.

### 5.2 Percent change used by alert evaluation

For a valid baseline price and current price, percent change is calculated as:

```text
percentChange = ((currentPrice - baselinePrice) / baselinePrice) * 100
```

For example, if the baseline is `$100.00` and the current price is `$100.60`:

```text
((100.60 - 100.00) / 100.00) * 100 = 0.6%
```

The calculation returns zero when there is no baseline or when the baseline price is zero. Alert evaluation separately requires a valid baseline, so a missing baseline does not produce an alert.

### 5.3 Time-window baseline selection

The alert baseline is not simply the immediately preceding ticker:

1. For a current event at time `T`, compute the target time `T - ALERT_WINDOW_MS`.
2. Find the latest already-recorded event for the same symbol whose timestamp is at or before that target.
3. Accept it only if it is no more than `ALERT_BASELINE_TOLERANCE_MS` earlier than the target.
4. If there is no eligible event, skip alert evaluation for this ticker.

Defaults are a 60-second window and a 10-second tolerance. Thus, for an event at 12:01:00, the target is 12:00:00 and an event from 11:59:50 through 12:00:00 can qualify; an event after 12:00:00 cannot be used because it is newer than the target.

The tracker stores timestamped prices separately for each symbol in process memory. It sorts out-of-order arrivals by their event timestamp and prunes history older than the window plus tolerance. It does not load the old `price_events` collection to seed alert baselines, so restarting the consumer resets this comparison history. Cooldown state is restored separately from persisted alerts.

### 5.4 Alert threshold and cooldown

An alert is eligible when:

```text
absolute(percentChange) >= ALERT_THRESHOLD_PERCENT
```

The default threshold is `0.5%`, so an increase or decrease of at least that magnitude qualifies. An alert is suppressed if the same symbol is still within its cooldown; the default cooldown is five minutes. Cooldown state is per symbol, and a successful database insert is followed by recording that symbol's alert time. Before connecting to Kafka, the consumer restores each supported symbol's latest persisted alert event timestamp; startup fails if this state cannot be loaded or a supported symbol has an invalid alert timestamp. Price events and metrics continue to be processed during warm-up and cooldown.

An alert document includes the symbol, type, message, percent change, current and baseline prices, current timestamp, comparison timestamp, and comparison-window duration.

### 5.5 Chart moving average and axis

The chart calculates a trailing simple moving average over up to 50 points from the history passed to it. The API request from the dashboard currently asks for only 10 history records, so the chart can currently average at most those 10 points—not 50—until the requested history limit is increased.

This chart-side calculation is separate from the backend metric's five-event average. The metrics table displays the backend value; the chart's green line is calculated in the browser from the fetched history.

For very narrow price ranges, the chart attempts to use `$0.01` Y-axis intervals, adding one interval of padding at either end. To avoid a crowded axis, it falls back to automatic ticks if the resulting axis would have more than eight ticks. A narrow, fixed interval makes small changes easier to see but can visually exaggerate their magnitude.

## 6. MongoDB data model

The default database is `crypto_analytics`. The application uses three collections:

### `price_events`

One document per consumed ticker event:

```json
{
  "symbol": "BTC-USD",
  "price": 75791.89,
  "timestamp": "2026-11-07T00:04:00.000Z",
  "receivedAt": "2026-11-07T00:04:00.145Z"
}
```

`timestamp` is the event time from Coinbase; `receivedAt` is set by the consumer when it writes the record.

### `metrics`

One upserted snapshot per symbol, keyed by `symbol`, containing the latest price, selected previous/baseline price, backend moving average, percent change, and update timestamp. It is a current snapshot, not an event-by-event history.

### `alerts`

An append-only record for each alert successfully inserted. The collection may not exist until the first alert is written.

The consumer enforces `MAX_EVENTS_PER_SYMBOL` (default `10000`) for raw price events by counting documents and deleting the oldest excess documents by timestamp. This retention process does not apply the same cap to the metrics or alerts collections.

## 7. REST API

All application endpoints use the `/api` prefix and return JSON.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Returns a service status and current timestamp; it does not verify MongoDB or Kafka health. |
| `GET` | `/api/prices/latest` | Returns latest price and update time from the `metrics` collection. |
| `GET` | `/api/prices/history/:symbol?limit=20` | Returns recent raw events for a symbol, newest first. |
| `GET` | `/api/metrics` | Returns the current metrics snapshot for each symbol. |
| `GET` | `/api/alerts?limit=20` | Returns the newest alert documents first. |

History and alert limits default to 20 when omitted or not numerically provided. The dashboard overrides these defaults by requesting 10 history records and 10 alerts. API responses generally include a `success` flag, a `count`, and a `data` array; health uses its own status response.

## 8. Configuration

The API server, producer, and consumer load local environment variables with `dotenv`. Defaults below are taken from the source configuration; do not commit real credentials in `.env` files.

| Variable | Service | Default | Description |
|---|---|---:|---|
| `PORT` | API | `5000` | HTTP port for the Express API. |
| `MONGO_URI` | API, consumer | `mongodb://localhost:27017` | MongoDB connection URI. Both services must point at the same database instance. |
| `DB_NAME` | API, consumer | `crypto_analytics` | MongoDB database name. |
| `KAFKA_BROKER` | Producer, consumer | `localhost:9092` | Kafka broker address for locally run Node services. |
| `KAFKA_TOPIC` | Producer, consumer | `crypto-prices` | Shared Kafka topic name. |
| `COINBASE_WS_URL` | Producer | `wss://ws-feed.exchange.coinbase.com` | Coinbase WebSocket URL. |
| `ALERT_WINDOW_MS` | Consumer | `60000` | Positive finite duration in milliseconds used to select an alert baseline. |
| `ALERT_BASELINE_TOLERANCE_MS` | Consumer | `10000` | Nonnegative finite duration in milliseconds; zero requires an exact target-time baseline. |
| `ALERT_THRESHOLD_PERCENT` | Consumer | `0.5` | Positive finite percent change needed for an alert. |
| `ALERT_COOLDOWN_MS` | Consumer | `300000` | Nonnegative finite per-symbol cooldown in milliseconds; zero disables cooldown. |
| `MOVING_AVERAGE_WINDOW` | Consumer | `5` | Positive safe integer number of recent raw events used by the backend average. |
| `MAX_EVENTS_PER_SYMBOL` | Consumer | `10000` | Positive safe integer raw event retention cap per symbol. |

The Coinbase product IDs are currently listed directly in `producer/src/config.js`: BTC-USD, ETH-USD, and SOL-USD. The chart's 50-point window and dashboard's 10-record history request are currently set in frontend source rather than environment variables.

## 9. Running locally

Prerequisites: Docker with Compose, Node.js/npm, internet access to Coinbase, and available local ports `2181`, `27017`, `5000`, and `9092` (Vite normally uses `5173`).

### Start infrastructure

From the repository root:

```bash
docker compose up -d
```

This starts ZooKeeper, Kafka, and the Compose-managed MongoDB. If another local MongoDB is already using port `27017`, resolve the port/URI choice before starting; otherwise services may connect to different MongoDB instances and appear to have inconsistent data.

### Install application dependencies

Run once in each application directory:

```bash
cd api-server
npm install

cd ../producer
npm install

cd ../consumer
npm install

cd ../frontend
npm install
```

### Start the application processes

Open separate terminals from the repository root and start each service:

```bash
cd api-server
npm start
```

```bash
cd consumer
npm start
```

```bash
cd producer
npm start
```

```bash
cd frontend
npm run dev
```

Open `http://localhost:5173`, then navigate to the dashboard. Starting infrastructure alone does not start these services. When all services are running, the producer sends new ticks through Kafka, the consumer stores data, the API serves it, and dashboard fetches display it.

## 10. Tests and validation

The repository includes Jest tests for API routes and consumer analytics:

```bash
cd api-server
npm test

cd ../consumer
npm test
```

Frontend static checks/build:

```bash
cd frontend
npm run lint
npm run build
```

The producer package does not currently have an automated test suite.

## 11. Current boundaries and operational considerations

- **Dashboard is fetch-based, not push-based.** It does not update continuously without another fetch.
- **Chart and backend averages differ.** The backend uses five recent stored events by default; the chart uses up to 50 points but currently receives only 10 records.
- **Alert baseline state is volatile.** The in-memory price history used for alert baselines resets on restart; old MongoDB price events are not used to initialize it. Cooldowns are restored from persisted alert timestamps, but concurrent consumers do not share live cooldown updates.
- **Persistence retention is limited to raw events.** `price_events` is capped per symbol; alerts are not pruned by this setting.
- **Single-broker infrastructure is not highly available.** The provided Compose configuration is for local development.
- **Local MongoDB selection matters.** A host-installed MongoDB and the Compose MongoDB may be different instances even if both use port 27017 at different times or loopback addresses.
- **Frontend API URL is local-only by default.** Public deployment requires API URL configuration and reachable infrastructure.
- **No authentication is implemented.** The current API is a simple demo interface, not a production access-control boundary.
- **Error recovery is basic.** The WebSocket client reconnects after closure, but producer publishing and consumer message processing primarily log failures; this project does not implement a full retry/dead-letter strategy.

## 12. Planned enhancements

The project README's roadmap includes:

- Browser push/live updates and automatic dashboard refresh.
- Multi-coin comparison and system monitoring views.
- Cloud deployment and CI/CD.
- User authentication and authorization.
- Alert subscriptions (for example email or Telegram).
- Redis caching and machine-learning-based anomaly detection.

These are roadmap items, not claims about current functionality.

## 13. Source map

| Area | Key files |
|---|---|
| Local infrastructure | `docker-compose.yml` |
| Coinbase ingestion and Kafka publishing | `producer/src/coinbaseClient.js`, `producer/src/kafkaProducer.js`, `producer/src/config.js` |
| Kafka processing and alert calculations | `consumer/src/kafkaConsumer.js`, `consumer/src/analytics.js`, `consumer/src/config.js` |
| MongoDB connections | `consumer/src/mongoClient.js`, `api-server/src/db.js` |
| REST API | `api-server/src/app.js`, `api-server/routes/` |
| Dashboard data fetching | `frontend/src/services/api.js`, `frontend/src/pages/Dashboard.jsx` |
| Chart and visualization | `frontend/src/components/PriceTrendChart.jsx`, `frontend/src/components/` |
