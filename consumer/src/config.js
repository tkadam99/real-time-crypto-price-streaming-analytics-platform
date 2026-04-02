require("dotenv").config();

module.exports = {
  kafkaBroker: process.env.KAFKA_BROKER || "localhost:9092",
  kafkaTopic: process.env.KAFKA_TOPIC || "crypto-prices",
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  dbName: process.env.DB_NAME || "crypto_analytics",
  alertThresholdPercent: Number(process.env.ALERT_THRESHOLD_PERCENT || 1.5),
  movingAverageWindow: Number(process.env.MOVING_AVERAGE_WINDOW || 5),
  maxEventsPerSymbol: Number(process.env.MAX_EVENTS_PER_SYMBOL || 10000),
};