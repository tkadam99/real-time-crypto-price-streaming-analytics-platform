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

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return "event must be an object";
  }

  if (typeof event.symbol !== "string" || !config.symbols.includes(event.symbol)) {
    return "unsupported or missing symbol";
  }

  if (
    typeof event.price !== "number" ||
    !Number.isFinite(event.price) ||
    event.price <= 0
  ) {
    return "price must be a finite positive number";
  }

  if (
    typeof event.timestamp !== "string" ||
    event.timestamp.trim() === "" ||
    !Number.isFinite(Date.parse(event.timestamp))
  ) {
    return "missing or invalid timestamp";
  }

  return null;
}

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
  const eventTime = new Date(Date.parse(event.timestamp));
  const latestHistoryTime = recentEvents.length
    ? new Date(Date.parse(recentEvents[0].timestamp))
    : eventTime;
  const storedUpdatedAt = {
    $convert: {
      input: "$updatedAt",
      to: "date",
      onError: null,
      onNull: null,
    },
  };
  const isNewerSnapshot = {
    $or: [
      { $eq: [storedUpdatedAt, null] },
      { $gt: [{ $literal: eventTime }, storedUpdatedAt] },
    ],
  };
  const shouldUpdateMovingAverage = {
    $or: [
      isNewerSnapshot,
      {
        $gte: [{ $literal: latestHistoryTime }, storedUpdatedAt],
      },
    ],
  };

  // Atomically keep snapshot fields from the newest event timestamp.
  await metricsCollection.updateOne(
    { symbol: event.symbol },
    [
      {
        $set: {
          symbol: { $literal: event.symbol },
          latestPrice: {
            $cond: [isNewerSnapshot, { $literal: event.price }, "$latestPrice"],
          },
          previousPrice: {
            $cond: [isNewerSnapshot, { $literal: previousPrice }, "$previousPrice"],
          },
          movingAverage: {
            $cond: [
              shouldUpdateMovingAverage,
              { $literal: Number(movingAverage.toFixed(4)) },
              "$movingAverage",
            ],
          },
          percentChange: {
            $cond: [
              isNewerSnapshot,
              { $literal: Number(percentChange.toFixed(4)) },
              "$percentChange",
            ],
          },
          updatedAt: {
            $cond: [
              isNewerSnapshot,
              { $literal: event.timestamp },
              "$updatedAt",
            ],
          },
        },
      },
    ],
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
      if (!message.value) {
        console.warn("Discarding invalid Kafka event: message value is missing");
        return;
      }

      let event;
      try {
        event = JSON.parse(message.value.toString());
      } catch (error) {
        console.error("Discarding malformed Kafka event JSON:", error.message);
        return;
      }

      const validationError = validateEvent(event);
      if (validationError) {
        console.warn("Discarding invalid Kafka event:", validationError);
        return;
      }

      await processMessage(event);
    },
  });
}

module.exports = {
  startConsumer,
};