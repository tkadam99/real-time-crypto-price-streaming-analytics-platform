require("dotenv").config();

module.exports = {
  kafkaBroker: process.env.KAFKA_BROKER || "localhost:9092",
  kafkaTopic: process.env.KAFKA_TOPIC || "crypto-prices",
};