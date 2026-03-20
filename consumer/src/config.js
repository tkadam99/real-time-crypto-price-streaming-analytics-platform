require("dotenv").config();

module.exports = {
  kafkaBroker: process.env.KAFKA_BROKER || "localhost:9092",
  kafkaTopic: process.env.KAFKA_TOPIC || "crypto-prices",
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  dbName: process.env.DB_NAME || "crypto_analytics",
};