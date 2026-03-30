require("dotenv").config();

module.exports = {
  kafkaBroker: process.env.KAFKA_BROKER || "localhost:9092",
  kafkaTopic: process.env.KAFKA_TOPIC || "crypto-prices",
  coinbaseWsUrl: process.env.COINBASE_WS_URL || "wss://ws-feed.exchange.coinbase.com",     //Coinbase WebSocket URL for live prices
  symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
};