const { Kafka } = require("kafkajs");
const { getDB } = require("./mongoClient");
const config = require("./config");
const {
  calculatePercentChange,
  calculateMovingAverage,
  shouldCreateAlert,
  buildAlert,
  createLivePriceTracker,
} = require("./analytics");

// Creating a Kafka client
const kafka = new Kafka({
  clientId: "crypto-price-consumer",    // Logical Identifier for app in kafka
  brokers: [config.kafkaBroker],   // Kafka broker address (localhost:9092) this app connects to
});

const consumer = kafka.consumer({ groupId: "crypto-analytics-group" });
const livePriceTracker = createLivePriceTracker();

async function processMessage(event) {
  const db = getDB();

  const priceEventsCollection = db.collection("price_events");
  const metricsCollection = db.collection("metrics");
  const alertsCollection = db.collection("alerts");
  const baseline = livePriceTracker.getBaseline(event.symbol, event.timestamp);
  const previousPrice = baseline?.price ?? null;
  const percentChange = calculatePercentChange(previousPrice, event.price);

  //Store raw price event
  await priceEventsCollection.insertOne({
    symbol: event.symbol,
    price: event.price,
    timestamp: event.timestamp,
    receivedAt: new Date().toISOString(),
  });

  //------------------------------------------------------------------------------------------------

  // LIMIT HISTORY SIZE PER SYMBOL
  // Keep only last N events per symbol
  // Delete older ones
  
  const maxEventsPerSymbol = config.maxEventsPerSymbol;

  const totalCount = await priceEventsCollection.countDocuments({
    symbol: event.symbol,
  });

  if (totalCount > maxEventsPerSymbol) {
    const excess = totalCount - maxEventsPerSymbol;

    const oldDocs = await priceEventsCollection
      .find({ symbol: event.symbol })
      .sort({ timestamp: 1 }) // oldest first
      .limit(excess)
      .project({ _id: 1 })
      .toArray();

    const idsToDelete = oldDocs.map(doc => doc._id);

    await priceEventsCollection.deleteMany({
      _id: { $in: idsToDelete },
    });

    console.log(`Cleaned ${idsToDelete.length} old events for ${event.symbol}`);
  }

  //------------------------------------------------------------------------------------------------

  //Find recent events for same symbol to compute analytics
  const recentEvents = await priceEventsCollection
    .find({ symbol: event.symbol })
    .sort({ timestamp: -1 })
    .limit(config.movingAverageWindow)
    .toArray();

  const prices = recentEvents.map((doc) => doc.price);
  const movingAverage = calculateMovingAverage(prices);

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

  livePriceTracker.recordPrice(event.symbol, event.price, event.timestamp);

  // Create an alert only when a valid time-window comparison meets the threshold.
  if (
    baseline &&
    shouldCreateAlert(percentChange) &&
    !livePriceTracker.isOnCooldown(event.symbol, event.timestamp)
  ) {
    const alert = buildAlert(
      event.symbol,
      percentChange,
      event.price,
      previousPrice,
      event.timestamp,
      new Date(baseline.timestamp).toISOString(),
      config.alertWindowMs
    );

    await alertsCollection.insertOne(alert);
    livePriceTracker.recordAlert(event.symbol, event.timestamp);
    console.log("Alert created:", alert);
  }

  console.log("Processed event:", {
    symbol: event.symbol,
    latestPrice: event.price,
    previousPrice,
    percentChange: Number(percentChange.toFixed(4)),
    movingAverage: Number(movingAverage.toFixed(4)),
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
      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch (error) {
        console.error("Discarding malformed Kafka message:", error.message);
        return;
      }

      await processMessage(event);
    },
  });
}

module.exports = {
  startConsumer,
};