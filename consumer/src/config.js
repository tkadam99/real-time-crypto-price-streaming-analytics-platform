require("dotenv").config();

module.exports = {
  kafkaBroker: process.env.KAFKA_BROKER || "localhost:9092",
  kafkaTopic: process.env.KAFKA_TOPIC || "crypto-prices",
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  dbName: process.env.DB_NAME || "crypto_analytics",
  symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
  alertThresholdPercent: Number(process.env.ALERT_THRESHOLD_PERCENT || 0.5),
  alertWindowMs: Number(process.env.ALERT_WINDOW_MS || 60_000),
  alertBaselineToleranceMs: Number(
    process.env.ALERT_BASELINE_TOLERANCE_MS || 10_000
  ),
  alertCooldownMs: Number(process.env.ALERT_COOLDOWN_MS || 300_000),
  movingAverageWindow: Number(process.env.MOVING_AVERAGE_WINDOW || 5),
  maxEventsPerSymbol: Number(process.env.MAX_EVENTS_PER_SYMBOL || 10000),
};