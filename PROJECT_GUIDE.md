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

The consumer subscribes with `fromBeginning: true`. When a group has no committed offset for a partition, it starts at the earliest record still retained by Kafka, which can include historical events. Valid committed group offsets remain authoritative and are not rewound on restart. Records already removed by broker retention cannot be replayed.

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

The tracker stores timestamped prices separately for each symbol in process memory. It sorts out-of-order arrivals by their event timestamp and prunes history older than the window plus tolerance. Before consuming, the consumer streams retained `price_events` within that horizon relative to each symbol's newest persisted event into the tracker. Events are ordered by event time, then receipt time and identity for ties. If retained history lacks an eligible baseline, startup warns and new events must warm up the tracker; malformed restored history or database errors fail startup. Cooldown state is restored separately from persisted alerts.

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

After computing analytics and updating metrics, the consumer enforces `MAX_EVENTS_PER_SYMBOL` (default `10000`) for raw price events by scanning each symbol in reverse `(timestamp, receivedAt, _id)` order, skipping the newest entries up to the cap, and deleting the remaining IDs for that symbol. It repeats this check on replay so a failed prune can be retried. The read and delete are not atomic across concurrent consumers or other writers, so the exact cap is not guaranteed during concurrent processing. A replay of an already-pruned Kafka record can recreate it before the next prune. This retention process does not apply the same cap to the metrics or alerts collections.

The consumer persists original alert decisions in `alert_decisions` independently
of raw history, keyed by Kafka topic, partition, and offset. New decisions include
the consumer group, topic, partition, and exact BSON 64-bit offset; startup creates
the `decision_group_topic_partition_offset` index alongside the unique `_id` index.
The `_id` is not group-scoped: sharing the collection between groups is unsupported,
and a conflicting recorded group fails processing. Legacy decisions without any
cleanup metadata retain their original decision and are reported by identity when
encountered; their group ownership requires a controlled migration. Partial or
inconsistent metadata fails processing. On replay, the consumer uses
the persisted positive or null decision; a valid decision in a legacy raw record
is migrated if no separate decision exists. Legacy decisions already lost to
retention cannot be reconstructed.

After the consumer starts, a tracked reconciliation worker fetches
committed next offsets for its group and topic on startup, after commit or group
join notifications, and every 60 seconds. It logs per-partition offset status and
a bounded sample of at most 100 index-matched decisions strictly below each
verified offset; the sample is not a total count. Missing or invalid offsets do
not produce an eligibility sample. By default it is read-only and does not
delete decisions or modify Kafka offsets. Errors are logged and retried on a
later trigger or periodic cycle; shutdown drains in-flight reconciliation
within the existing deadline.

`ALERT_DECISION_CLEANUP_ENABLED` is strictly `true` or `false`, defaults to
`false`, and is not enabled by the normal configuration. Explicitly enabling it
allows the same worker to inspect at most four partitions per cycle, selecting
at most 500 validated decisions for one deletion batch per partition. It checks
the broker again immediately before every delete; missing, invalid or decreased
boundaries prevent that batch. The indexed deletion repeats the group, topic,
partition, exact selected identity, metadata types and strict numeric offset
boundary, and verifies the selected decision has not changed. Positive and
null decisions receive the same treatment. Metadata-free, ambiguous, malformed
and conflicting records are left untouched. When cleanup is enabled, startup
creates `decision_cleanup_pagination` on `(groupId, topic, partition, offset,
_id)`. A bounded, in-memory per-partition cursor advances past ambiguous
records, including ties at the same offset, then wraps to revisit earlier
records. A restart resets these cursors. A full page or unvisited partitions
schedule a coalesced follow-up after 50 ms; partition rotation provides fairness.
When no deletions occur, automatic scans stop after a complete empty partition
sweep or eight cycles containing full pages, and failures, partial deletions or
uncertain/decreased boundaries defer further work to a later trigger or the
60-second periodic cycle. This bounds retries while allowing the cursor to
progress through ambiguous records over subsequent triggers. Operators must
investigate ambiguous records rather than silently migrate or delete them.

Cleanup requires one application group to own the collection, no other group
depending on the same identities, forward-only offsets, no concurrent
administrative rewind, and no group identity reuse or topic recreation. Group
ownership cannot be independently established from legacy records. A Kafka
recheck and MongoDB deletion are not atomic: an administrative reset after the
check can make deletion unsafe. Do not enable cleanup without enforcing these
operational assumptions and a controlled rollout. Storage is not absolutely
bounded during failures, absent commits, or unresolved ambiguous records.

On startup, the consumer ensures a unique `metrics.symbol` index, two non-unique
`price_events` indexes on `(symbol, timestamp, receivedAt, _id)` for the
different existing sort directions, and a non-unique descending
`alerts.timestamp` index. MongoDB's `_id` indexes remain unique for event and
alert identity. Index creation failures stop consumer startup; the consumer
does not delete records to resolve conflicts. Computed event-time conversions
in restoration pipelines still require additional processing. Baseline history
requires a computed sort; cooldown restoration selects the latest alert per
symbol without a global sort. The existing indexes cannot directly order
converted event times when stored timestamp formats differ.

## 7. REST API

All application endpoints use the `/api` prefix and return JSON.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | Checks API readiness with a MongoDB ping using the shared connection. Returns HTTP 200 when available or 503 when unavailable; it does not check Kafka, Coinbase, the producer, or the consumer. |
| `GET` | `/api/prices/latest` | Returns latest price and update time from the `metrics` collection. |
| `GET` | `/api/prices/history/:symbol?limit=20` | Returns recent raw events for a symbol, newest first. |
| `GET` | `/api/metrics` | Returns the current metrics snapshot for each symbol. |
| `GET` | `/api/alerts?limit=20` | Returns the newest alert documents first. |

History and alert limits default to 20 when omitted. Explicit limits must contain decimal digits only and be between 1 and 10000 inclusive; invalid or repeated limits return HTTP 400. History accepts only `BTC-USD`, `ETH-USD`, and `SOL-USD`, with unsupported symbols also returning HTTP 400. The dashboard requests 10 history records and 10 alerts. API responses generally include a `success` flag, a `count`, and a `data` array; health uses its own status response.

The health response retains `status`, `service`, and `Timestamp` fields. A successful ping returns `status: "ok"`; a failed or timed-out ping returns `status: "unavailable"` without database error details. The ping has a one-second client-side timeout. The API normally connects to MongoDB before it starts listening, so an initial connection failure can prevent the endpoint from being available at all.

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
| `CONSUMER_PROCESSING_TIMINGS` | Consumer | `false` | Set to `true` to enable aggregate consumer processing timing logs; `false` disables them. Other values fail startup. |
| `CONSUMER_VERBOSE_EVENT_LOGGING` | Consumer | `false` | Set to `true` to log each processed event and retention deletion; `false` suppresses per-event and single-record cleanup logs. Other values fail startup. |

The historical consumer logs its timing and verbose-logging settings at startup.
When timings are enabled, it emits a JSON summary prefixed
`Consumer processing timings:` at 60-second intervals when completed processing
attempts were recorded. Reports are independent of verbose event logging. It uses a monotonic clock and
reports successful event counts and total processing time, failed attempt counts,
and per-operation counts, totals, averages, p50, and p95 in milliseconds. Operation
measurements include failed operations up to the point of failure; optional
operations have zero counts when not executed. Summaries distinguish newly
inserted records, recognized replays, and attempts whose identity could not yet
be determined. A replay whose raw record was already pruned can be classified as
new. Counts and totals cover the entire reporting interval, while percentiles use
the most recent 1,024 samples per operation and classification. In-flight work is
reported in the interval when it finishes; shutdown or a crash can lose an
unreported interval. The event timer starts after validation and excludes Kafka
fetching and offset commits. Enabling timing adds clock reads, bounded memory,
and periodic logging. `decisionPersistence` covers decision lookup, legacy
lookup, calculation when needed, and decision insertion.

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

The consumer's real-Kafka reconciliation test is opt-in. With Kafka and
MongoDB reachable from the host, run in PowerShell from `consumer`:

```powershell
$env:KAFKA_INTEGRATION_BROKER = "localhost:9092"
$env:MONGO_INTEGRATION_URI = "mongodb://127.0.0.1:27017"
npm test -- --runTestsByPath tests/commitReconciliation.kafka.integration.test.js
```

It creates and removes a UUID-named test topic, consumer group, and MongoDB
database. The Kafka group commits test offsets only; cleanup is enabled solely
for an isolated test collection. The Kafka test is skipped unless both variables are
set. MongoDB-only integration tests require `MONGO_INTEGRATION_URI`.

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
- **Alert state depends on retained history.** Startup restores baseline prices and cooldowns from MongoDB, but retention gaps can leave no eligible baseline. Concurrent consumers do not share live tracker or cooldown updates.
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
