# 🚀 Real-Time Crypto Price Streaming Analytics Platform

A real-time event-driven analytics platform that ingests live cryptocurrency price data, processes it using Kafka, stores analytics in MongoDB, and visualizes insights through a React dashboard.

For an in-depth explanation of the architecture, data flow, calculations, configuration, API, and local setup, see the [Project Guide](./PROJECT_GUIDE.md).

---

## 📌 Overview

This project demonstrates a full-stack distributed system capable of:

* Streaming real-time crypto data from Coinbase WebSocket
* Processing events using Kafka (Producer → Consumer model)
* Computing analytics like moving average and percent change
* Storing structured data in MongoDB
* Exposing REST APIs via Node.js
* Visualizing data through a modern React dashboard

---

## ✨ Features

* 📡 Real-time data ingestion (Coinbase WebSocket)
* ⚡ Event-driven architecture using Kafka
* 📊 Moving average & percent change analytics
* 🚨 Alert generation for price spikes
* 🗄️ MongoDB storage (events, metrics, alerts)
* 📈 Interactive dashboard with charts
* 🔄 Dynamic symbol selection (BTC, ETH, SOL)
* 🧠 Rolling window analytics (efficient computation)

---

## 🏗️ System Architecture

```
Coinbase WebSocket
        ↓
    Producer
        ↓
      Kafka Topic: crypto-prices
        ↓
    ┌───┴────────────────────┐
    ↓                        ↓
Analytics Consumer    Current-Price Consumer
(Historical)          (Latest Prices Only)
    ↓                        ↓
MongoDB collections:    current_prices
  price_events         (single doc per symbol)
  metrics
  alerts
    ↓                        ↓
    └────────┬───────────────┘
             ↓
        Express REST API
             ↓
        React Frontend
```

**Two Consumers:**
1. **Analytics Consumer** (`npm start`): Processes historical prices, computes moving averages, generates alerts, and stores data in `price_events`, `metrics`, and `alerts` collections.
2. **Current-Price Consumer** (`npm run start:current-prices`): Maintains only the latest price per symbol in the `current_prices` collection. Required for the `/api/prices/current` endpoint (dashboard's latest-price cards).

---

## ⚙️ Tech Stack

### Frontend

* React (Vite)
* Recharts (data visualization)
* CSS (custom styling)

### Backend

* Node.js
* Express.js

### Data & Streaming

* Apache Kafka
* KafkaJS

### Database

* MongoDB

### Tools

* Docker (for infrastructure)
* Postman (API testing)

---

## 🔄 Data Flow

1. Producer connects to Coinbase WebSocket
2. Streams live crypto price data
3. Publishes events to Kafka topic `crypto-prices`
4. **Analytics Consumer** (independent process):
   - Reads events from Kafka group `crypto-analytics-group`
   - Computes moving averages and percent change
   - Stores raw events in `price_events` collection
   - Stores computed metrics in `metrics` collection
   - Generates spike alerts in `alerts` collection
5. **Current-Price Consumer** (independent process, required for dashboard):
   - Runs in a separate consumer group (`crypto-current-price-group`)
   - Maintains latest price per symbol in `current_prices` collection
   - Supplies the `/api/prices/current` endpoint
6. API exposes data from MongoDB collections to frontend
7. React dashboard visualizes insights

---

## 📈 Analytics and Alert Behavior

* Moving averages use the most recent stored price events for each symbol.
* The analytics consumer maintains a rolling in-memory price history per symbol for alert comparisons.
* On startup, the analytics consumer restores retained price history for alert baselines. If that history is insufficient, new events warm up the tracker; no alert is evaluated until a valid baseline is available.
* Each ticker is compared with the most recent event at or before one minute earlier. The baseline must be within 10 seconds of the target time; otherwise that ticker is skipped for alert evaluation.
* An alert is created when the absolute percent change meets the configured threshold (0.5% by default), for either an increase or a decrease.
* A five-minute cooldown is applied independently per symbol. On restart, the analytics consumer restores cooldowns from persisted alert event timestamps. Prices and metrics continue to be processed during cooldown.
* Restored history is limited to the comparison window plus tolerance relative to each symbol's newest retained event.
* `ALERT_WINDOW_MS`, `ALERT_BASELINE_TOLERANCE_MS`, `ALERT_THRESHOLD_PERCENT`, and `ALERT_COOLDOWN_MS` configure the alert window, baseline tolerance, threshold, and cooldown.

---

## 📊 Dashboard Features

* Latest Prices Cards
* Metrics Table (price, moving avg, % change)
* 📈 Price Trend Chart with Moving Average
* Recent Alerts Panel
* Historical Price Data

---

## 🔌 API Endpoints

| Method | Endpoint                    | Source                                    |
| ------ | --------------------------- | ----------------------------------------- |
| GET    | /api/prices/current         | current-price consumer (`current_prices`) |
| GET    | /api/prices/latest          | analytics consumer (`metrics`)            |
| GET    | /api/prices/history/:symbol | analytics consumer (`price_events`)       |
| GET    | /api/metrics                | analytics consumer (`metrics`)            |
| GET    | /api/alerts                 | analytics consumer (`alerts`)             |
| GET    | /api/health                 | MongoDB connectivity check; returns HTTP 503 when unavailable |

---

## 🗄️ Database Collections

* **price_events** → raw streaming cryptocurrency prices (analytics consumer)
* **metrics** → latest computed analytics per symbol: moving average, percent change (analytics consumer)
* **alerts** → spike detection alerts when price change exceeds threshold (analytics consumer)
* **current_prices** → latest price per symbol with Kafka metadata (current-price consumer)

---

## 🛠️ Local Development Setup

### Prerequisites

- Node.js 18+ (with npm)
- Docker and Docker Compose
- Git

### Step 1: Clone and Install Dependencies

```bash
git clone <repo-url>
cd real-time-crypto-price-streaming-analytics-platform
```

Install dependencies for all services:

```bash
# API Server
cd api-server
npm install
cd ..

# Producer (Coinbase WebSocket)
cd producer
npm install
cd ..

# Consumer (Analytics & Current-Price)
cd consumer
npm install
cd ..

# Frontend
cd frontend
npm install
cd ..
```

### Step 2: Start Docker Infrastructure

Start Kafka, ZooKeeper, and MongoDB:

```bash
docker-compose up -d
```

Verify containers are running:

```bash
docker-compose ps
```

You should see:
- `zookeeper` listening on port 2181
- `kafka` listening on port 9092
- `mongodb` listening on port 27017

### Step 3: Start the Producer

In a new terminal, start the Coinbase WebSocket producer:

```bash
cd producer
npm start
```

Expected output: Producer connects to Coinbase WebSocket and begins publishing price events to the `crypto-prices` Kafka topic.

**Environment Variables (Producer):**
- `KAFKA_BROKER` (default: `localhost:9092`)
- `KAFKA_TOPIC` (default: `crypto-prices`)
- `COINBASE_WS_URL` (default: `wss://ws-feed.exchange.coinbase.com`)

### Step 4: Start the Analytics Consumer

In a new terminal, start the analytics consumer:

```bash
cd consumer
npm start
```

Expected output: Consumer connects to Kafka group `crypto-analytics-group`, processes price events, computes analytics, generates alerts, and stores data in MongoDB collections: `price_events`, `metrics`, and `alerts`.

**Environment Variables (Analytics Consumer):**
- `KAFKA_BROKER` (default: `localhost:9092`)
- `KAFKA_TOPIC` (default: `crypto-prices`)
- `MONGO_URI` (default: `mongodb://localhost:27017`)
- `DB_NAME` (default: `crypto_analytics`)
- `ALERT_THRESHOLD_PERCENT` (default: `0.5`)
- `ALERT_WINDOW_MS` (default: `60000` - 1 minute)
- `ALERT_BASELINE_TOLERANCE_MS` (default: `10000` - 10 seconds)
- `ALERT_COOLDOWN_MS` (default: `300000` - 5 minutes)
- `MOVING_AVERAGE_WINDOW` (default: `5`)
- `MAX_EVENTS_PER_SYMBOL` (default: `10000`)
- `CONSUMER_PROCESSING_TIMINGS` (default: `false` - set to `true` for performance diagnostics)
- `CONSUMER_VERBOSE_EVENT_LOGGING` (default: `false`)
- `ALERT_DECISION_CLEANUP_ENABLED` (default: `false`)

### Step 5: Start the Current-Price Consumer

In a new terminal, start the current-price consumer:

```bash
cd consumer
npm run start:current-prices
```

Expected output: Consumer connects to Kafka group `crypto-current-price-group`, maintains the latest price per symbol in the `current_prices` MongoDB collection. This consumer is required for the dashboard's latest-price cards (endpoint: `GET /api/prices/current`).

**Environment Variables (Current-Price Consumer):**
- `KAFKA_BROKER` (default: `localhost:9092`)
- `KAFKA_TOPIC` (default: `crypto-prices`)
- `MONGO_URI` (default: `mongodb://localhost:27017`)
- `DB_NAME` (default: `crypto_analytics`)

### Step 6: Start the API Server

In a new terminal, start the Express API server:

```bash
cd api-server
npm start
```

Expected output: API server listens on port 5000 (or `PORT` environment variable).

**Environment Variables (API Server):**
- `PORT` (default: `5000`)
- `MONGO_URI` (default: `mongodb://localhost:27017`)
- `DB_NAME` (default: `crypto_analytics`)

API health check:

```bash
curl http://localhost:5000/api/health
```

Expected response (illustrative; timestamp will vary):
```json
{
  "status": "ok",
  "service": "api-server",
  "Timestamp": "2026-11-16T18:00:00.000Z"
}
```

### Step 7: Start the React Frontend

In a new terminal, start the Vite development server:

```bash
cd frontend
npm run dev
```

Expected output: Frontend server starts on `http://localhost:5173`

Open your browser and navigate to:

```
http://localhost:5173
```

You should see:
- Latest prices for BTC-USD, ETH-USD, SOL-USD
- Metrics table with moving averages and percent change
- Price trend chart
- Recent alerts panel

---

## ✅ Verifying the Setup

### 1. Check Docker Containers

```bash
docker-compose ps
```

All containers should show `Up` status.

### 2. Verify Kafka Topic

```bash
docker exec kafka kafka-topics --list --bootstrap-server localhost:9092
```

Should include `crypto-prices`.

### 3. Check MongoDB Collections

```bash
docker exec mongodb mongosh crypto_analytics --eval "db.getCollectionNames()"
```

Expect: `['price_events', 'metrics', 'alerts', 'current_prices']` (after data flows).

### 4. Query Current Prices via API

```bash
curl http://localhost:5000/api/prices/current
```

Expected: JSON object with `success: true`, `count` (number of symbols), and `data` array containing latest price records from the current-price consumer for BTC-USD, ETH-USD, SOL-USD. This endpoint requires the current-price consumer to be running.

### 5. Query Latest Prices via API (from metrics)

```bash
curl http://localhost:5000/api/prices/latest
```

Expected: JSON object with `success: true`, `count` (number of symbols), and `data` array containing latest prices from the analytics consumer (`metrics` collection) for BTC-USD, ETH-USD, SOL-USD.

### 6. Query Recent Alerts via API

```bash
curl http://localhost:5000/api/alerts
```

Expected: Array of recent spike-detection alerts (may be empty initially).

### 7. Check Dashboard

Navigate to `http://localhost:5173`:
- Verify prices update as you refresh the page
- Select a different symbol to view its metrics
- Monitor the alert panel for price spike alerts

---

## 🛑 Stopping Services

### Stop All Containers

```bash
docker-compose down
```

### Stop Individual Services

Press `Ctrl+C` in each service terminal to gracefully stop:
- Frontend dev server
- API server
- Analytics consumer
- Current-price consumer
- Producer

### Clean Up

To reset Docker volumes (deletes all Kafka and MongoDB data):

```bash
docker-compose down -v
```

---

## 🔧 Troubleshooting

### Producer not connecting to Coinbase

- Verify internet connection and firewall rules
- Check `COINBASE_WS_URL` environment variable
- Ensure Kafka is running: `docker-compose ps`

### Consumer not receiving messages

- Verify producer is running and publishing to Kafka
- Check Kafka logs: `docker logs kafka`
- Confirm MongoDB is running: `docker-compose ps`
- Check Kafka topic exists: `docker exec kafka kafka-topics --list --bootstrap-server localhost:9092`

### API returning 503 (Unavailable)

- Verify MongoDB is running: `docker-compose ps`
- Check MongoDB connection: `docker logs mongodb`
- Verify `MONGO_URI` and `DB_NAME` environment variables

### Frontend not loading data

- Verify API server is running and accessible: `curl http://localhost:5000/api/health`
- Check browser console for CORS or network errors
- Verify both consumers are running: analytics consumer (required) and current-price consumer (required for latest prices)
- Verify consumer has processed events (check MongoDB collections)

## 📁 Project Structure

```
real-time-crypto-price-streaming-platform/
│
├── api-server/                 # REST API server (Node.js + Express)
│   ├── routes/                # API route handlers
│   ├── src/                   # Core server logic (DB, analytics, utils)
│   ├── .env                   # Environment variables
│   ├── package.json
│   └── package-lock.json
│
├── producer/                  # Kafka producer (Coinbase WebSocket ingestion)
│   ├── src/                   # WebSocket + Kafka publishing logic
│   ├── .env
│   ├── package.json
│   └── package-lock.json
│
├── consumer/                  # Kafka consumer (analytics processing)
│   ├── src/                   # Processing logic, alerts, metrics computation
│   ├── .env
│   ├── package.json
│   └── package-lock.json
│
├── frontend/                  # React frontend (Vite)
│   ├── public/
│   ├── src/
│   │   ├── components/        # Reusable UI components
│   │   ├── pages/             # Pages (Dashboard, Docs, Project Info)
│   │   ├── styles/            # CSS files
│   │   └── utils/             # Helper functions (formatters, etc.)
│   ├── index.html
│   ├── vite.config.js
│   ├── package.json
│   └── README.md
│
├── docker-compose.yml         # Infrastructure (Kafka, MongoDB, etc.)
└── README.md                  # Project documentation
```


---

## ⚡ Key Design Decisions

* Kafka for decoupling ingestion and processing
* Rolling window analytics (efficient vs full scan)
* Hard cap retention strategy to prevent DB overflow
* REST APIs for simplicity in Version 1
* Modular service-based architecture

---

## ⚠️ Challenges Faced

* Managing real-time streaming consistency
* Handling large volume of events
* Designing efficient rolling analytics
* Preventing unbounded database growth
* Synchronizing frontend with backend updates

---

## ✅ Testing

### Backend API Testing
- Jest
- Supertest

Tested routes:
- `GET /api/health`
- `GET /api/metrics`
- `GET /api/alerts`
- `GET /api/prices/latest`
- `GET /api/prices/history/:symbol`

### Consumer Unit Testing
- Jest

Tested analytics logic:
- Moving average calculation
- Percent change calculation
- Alert threshold behavior
- Alert object generation

### Manual Testing
- Postman for API validation and debugging

---

## 🚀 Future Enhancements

### Version 2

* WebSocket live updates to frontend
* Multi-coin comparison charts
* System monitoring panel

### Version 3

* Cloud deployment (AWS/GCP)
* CI/CD pipeline
* User authentication & authorization
* Alert subscriptions (email/Telegram)
* Redis caching
* ML-based anomaly detection

---

## 👨‍💻 Author

**Tanmay Kadam**
MS Computer Science – Binghamton University

---

## ⭐ Final Note

This project demonstrates a complete real-time data pipeline combining streaming, processing, storage, and visualization — similar to production-grade analytics systems used in fintech and trading platforms.
