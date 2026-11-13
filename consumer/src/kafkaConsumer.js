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

async function ensureIndexes() {
  const db = getDB();
  const metricsCollection = db.collection("metrics");
  const duplicateSymbols = await metricsCollection
    .aggregate([
      { $group: { _id: "$symbol", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ])
    .toArray();

  if (duplicateSymbols.length > 0) {
    const symbols = duplicateSymbols.map(({ _id }) => _id).join(", ");
    throw new Error(
      `Cannot create unique metrics symbol index; duplicate symbols already exist: ${symbols}. Resolve these records before starting the consumer.`
    );
  }

  await metricsCollection.createIndex(
    { symbol: 1 },
    { unique: true, name: "unique_metrics_symbol" }
  );
}

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

async function processMessage(event, kafkaRecord) {
  const db = getDB();

  const priceEventsCollection = db.collection("price_events");
  const metricsCollection = db.collection("metrics");
  const alertsCollection = db.collection("alerts");
  const eventId = JSON.stringify([
    kafkaRecord.topic,
    kafkaRecord.partition,
    kafkaRecord.message.offset,
  ]);
  const identity = { _id: eventId };
  const baseline = livePriceTracker.getBaseline(event.symbol, event.timestamp);
  const candidatePreviousPrice = baseline?.price ?? null;
  const candidatePercentChange = calculatePercentChange(
    candidatePreviousPrice,
    event.price
  );
  const candidateAlert =
    baseline &&
    shouldCreateAlert(candidatePercentChange) &&
    !livePriceTracker.isOnCooldown(event.symbol, event.timestamp, eventId)
      ? buildAlert(
          event.symbol,
          candidatePercentChange,
          event.price,
          candidatePreviousPrice,
          event.timestamp,
          new Date(baseline.timestamp).toISOString(),
          config.alertWindowMs
        )
      : null;
  let storedEvent;

  try {
    const result = await priceEventsCollection.updateOne(
      identity,
      {
        $setOnInsert: {
          symbol: event.symbol,
          price: event.price,
          timestamp: event.timestamp,
          receivedAt: new Date().toISOString(),
          previousPrice: candidatePreviousPrice,
          percentChange: candidatePercentChange,
          alertCandidate: candidateAlert,
        },
      },
      { upsert: true }
    );
    storedEvent =
      result.upsertedCount === 1
        ? {
            previousPrice: candidatePreviousPrice,
            percentChange: candidatePercentChange,
            alertCandidate: candidateAlert,
          }
        : await priceEventsCollection.findOne(identity);
  } catch (error) {
    if (error.code !== 11000) throw error;

    storedEvent = await priceEventsCollection.findOne(identity);
    if (!storedEvent) throw error;
  }
  if (!storedEvent) {
    throw new Error(`Kafka event ${eventId} could not be loaded after persistence.`);
  }

  const previousPrice =
    storedEvent.previousPrice === undefined
      ? candidatePreviousPrice
      : storedEvent.previousPrice;
  const percentChange =
    storedEvent.percentChange === undefined
      ? candidatePercentChange
      : storedEvent.percentChange;
  const alertCandidate =
    storedEvent.alertCandidate === undefined
      ? candidateAlert
      : storedEvent.alertCandidate;

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
  const metricsUpdatePipeline = [
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
  ];

  try {
    await metricsCollection.updateOne(
      { symbol: event.symbol },
      metricsUpdatePipeline,
      { upsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;

    const existingMetrics = await metricsCollection.findOne({
      symbol: event.symbol,
    });
    if (!existingMetrics) throw error;

    await metricsCollection.updateOne(
      { symbol: event.symbol },
      metricsUpdatePipeline,
      { upsert: false }
    );
  }

  if (alertCandidate) {
    let alertCreated = false;
    try {
      const result = await alertsCollection.updateOne(
        identity,
        {
          $setOnInsert: {
            ...alertCandidate,
          },
        },
        { upsert: true }
      );
      alertCreated = result.upsertedCount === 1;
    } catch (error) {
      if (error.code !== 11000) throw error;

      const existingAlert = await alertsCollection.findOne(identity);
      if (!existingAlert) throw error;
    }

    livePriceTracker.recordAlert(event.symbol, event.timestamp, eventId);
    if (alertCreated) console.log("Alert created:", alertCandidate);
  }

  livePriceTracker.recordPrice(
    event.symbol,
    event.price,
    event.timestamp,
    eventId
  );

  console.log("Processed event:", {
    symbol: event.symbol,
    latestPrice: event.price,
    previousPrice,
    percentChange: Number(percentChange.toFixed(4)),
    movingAverage: Number(movingAverage.toFixed(4)),
  });
}

async function startConsumer() {
  await ensureIndexes();
  await consumer.connect();
  console.log(`Consumer connected to Kafka at ${config.kafkaBroker}`);

  await consumer.subscribe({
    topic: config.kafkaTopic,
    fromBeginning: false,
  });

  console.log(`Consumer subscribed to topic: ${config.kafkaTopic}`);

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
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

      await processMessage(event, { topic, partition, message });
    },
  });
}

module.exports = {
  startConsumer,
};