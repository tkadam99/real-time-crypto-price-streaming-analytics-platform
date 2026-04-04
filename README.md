# 🚀 Real-Time Crypto Price Streaming Analytics Platform

A real-time event-driven analytics platform that ingests live cryptocurrency price data, processes it using Kafka, stores analytics in MongoDB, and visualizes insights through a React dashboard.

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
      Kafka
        ↓
    Consumer
        ↓
     MongoDB
        ↓
     API Server
        ↓
   React Frontend
```

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
3. Publishes events to Kafka topic
4. Consumer reads events from Kafka
5. Computes analytics (moving average, % change)
6. Stores results in MongoDB
7. API exposes data to frontend
8. React dashboard visualizes insights

---

## 📊 Dashboard Features

* Latest Prices Cards
* Metrics Table (price, moving avg, % change)
* 📈 Price Trend Chart with Moving Average
* Recent Alerts Panel
* Historical Price Data

---

## 🔌 API Endpoints

| Method | Endpoint                    |
| ------ | --------------------------- |
| GET    | /api/prices/latest          |
| GET    | /api/prices/history/:symbol |
| GET    | /api/metrics                |
| GET    | /api/alerts                 |
| GET    | /api/health                 |

---

## 🗄️ Database Collections

* **price_events** → raw streaming data
* **metrics** → latest computed analytics per symbol
* **alerts** → spike detection alerts

---

## 🛠️ Local Setup

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd project-folder
```

---

### 2. Start infrastructure (Kafka + MongoDB)

```bash
docker-compose up -d
```

---

### 3. Install dependencies

```bash
# backend
cd backend
npm install

# frontend
cd ../frontend
npm install
```

---

### 4. Run services

```bash
# start API
npm start

# start producer
node producer.js

# start consumer
node kafkaConsumer.js

# start frontend
npm run dev
```

---

### 5. Open application

```text
http://localhost:5173
```

---

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

## 🚀 Future Enhancements

### Version 2

* WebSocket live updates to frontend
* Multi-coin comparison charts
* Auto-refresh dashboard
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
