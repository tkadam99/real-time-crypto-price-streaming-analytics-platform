require("dotenv").config();
const { Kafka } = require("kafkajs");
const { MongoClient } = require("mongodb");
const { CURRENT_PRICE_GROUP, createCurrentPriceService } = require("./currentPriceConsumer");

function main() {
  const kafka = new Kafka({
    clientId: "crypto-current-price-consumer",
    brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
  });
  const consumer = kafka.consumer({ groupId: CURRENT_PRICE_GROUP, allowAutoTopicCreation: false });
  const mongoClient = new MongoClient(process.env.MONGO_URI || "mongodb://localhost:27017");
  const service = createCurrentPriceService({
    consumer,
    mongoClient,
    dbName: process.env.DB_NAME || "crypto_analytics",
    topic: process.env.KAFKA_TOPIC || "crypto-prices",
    symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
  });
  void service.start().catch((error) => {
    console.error("Current-price fatal startup error:", error.message);
    process.exitCode = 1;
  });
}

if (require.main === module) main();
