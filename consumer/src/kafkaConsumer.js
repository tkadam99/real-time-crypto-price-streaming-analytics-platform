const { Kafka } = require("kafkajs");
const { getDB } = require("./mongoClient");
const config = require("./config");
const {
  calculatePercentChange,
  calculateMovingAverage,
  shouldCreateAlert,
  buildAlert,
} = require("./analytics");

// Creating a Kafka client
const kafka = new Kafka({
  clientId: "crypto-price-producer",    // Logical Identifier for app in kafka
  brokers: [config.kafkaBroker],   // Kafka broker address (localhost:9092) this app connects to
});

const consumer = kafka.consumer({ groupId: "crypto-analytics-group" });

async function processMessage(event) {
  const db = getDB();

  const priceEventsCollection = db.collection("price_events");
  const metricsCollection = db.collection("metrics");
  const alertsCollection = db.collection("alerts");

  //Store raw price event
  await priceEventsCollection.insertOne({
    symbol: event.symbol,
    price: event.price,
    timestamp: event.timestamp,
    receivedAt: new Date().toISOString(),
  });

  //Find recent events for same symbol to compute analytics
  const recentEvents = await priceEventsCollection
    .find({ symbol: event.symbol })
    .sort({ timestamp: -1 })
    .limit(config.movingAverageWindow)
    .toArray();

  const prices = recentEvents.map((doc) => doc.price);
  const movingAverage = calculateMovingAverage(prices);

  const previousEvent = recentEvents.length > 1 ? recentEvents[1] : null;
  const previousPrice = previousEvent ? previousEvent.price : null;
  const percentChange = calculatePercentChange(previousPrice, event.price);

  //Upsert latest metrics snapshot
  await metricsCollection.updateOne(
    { symbol: event.symbol },
    {
      $set: {
        symbol: event.symbol,
        latestPrice: event.price,
        previousPrice,
        movingAverage: Number(movingAverage.toFixed(4)),
        percentChange: Number(percentChange.toFixed(4)),
        updatedAt: event.timestamp,
      },
    },
    { upsert: true }
  );

  // 4. Create alert if threshold exceeded
  if (previousPrice !== null && shouldCreateAlert(percentChange)) {
    const alert = buildAlert(
      event.symbol,
      percentChange,
      event.price,
      previousPrice,
      event.timestamp
    );

    await alertsCollection.insertOne(alert);
    console.log("Alert created:", alert);
  }

  console.log("Processed event:", {
    symbol: event.symbol,
    latestPrice: event.price,
    previousPrice,
    movingAverage: Number(movingAverage.toFixed(4)),
    percentChange: Number(percentChange.toFixed(4)),
  });
}

async function startConsumer() {
  await consumer.connect();
  console.log(`Consumer connected to Kafka at ${config.kafkaBroker}`);

  await consumer.subscribe({
    topic: config.kafkaTopic,
    fromBeginning: false,
  });

  console.log(`Consumer subscribed to topic: ${config.kafkaTopic}`);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const event = JSON.parse(message.value.toString());
        await processMessage(event);
      } catch (error) {
        console.error("Error processing Kafka message:", error.message);
      }
    },
  });
}

module.exports = {
  startConsumer,
};