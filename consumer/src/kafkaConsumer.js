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

async function restoreAlertCooldowns() {
  const latestAlerts = await getDB()
    .collection("alerts")
    .aggregate([
      { $match: { symbol: { $in: config.symbols } } },
      {
        $set: {
          eventTime: {
            $convert: {
              input: "$timestamp",
              to: "date",
              onError: null,
              onNull: null,
            },
          },
        },
      },
      { $sort: { eventTime: -1, _id: 1 } },
      {
        $group: {
          _id: "$symbol",
          timestamp: { $first: "$eventTime" },
          eventId: { $first: "$_id" },
          invalidCount: {
            $sum: { $cond: [{ $eq: ["$eventTime", null] }, 1, 0] },
          },
        },
      },
    ])
    .toArray();

  for (const alert of latestAlerts) {
    if (alert.invalidCount > 0 || !alert.timestamp) {
      throw new Error(
        `Cannot restore alert cooldown for ${alert._id}: persisted alert timestamp is invalid.`
      );
    }
    livePriceTracker.recordAlert(
      alert._id,
      alert.timestamp.toISOString(),
      alert.eventId
    );
  }
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

  const alertCandidate =
    storedEvent.alertCandidate === undefined
      ? candidateAlert
      : storedEvent.alertCandidate;

  // Read history before retention pruning so the preceding event remains available.
  const recentEvents = await priceEventsCollection
    .find({ symbol: event.symbol })
    .sort({ timestamp: -1, receivedAt: 1, _id: 1 })
    .limit(Math.max(config.movingAverageWindow, 2))
    .toArray();

  const latestEvent = recentEvents[0] || event;
  const latestEventTime = Date.parse(latestEvent.timestamp);
  const precedingEvent =
    recentEvents.find(
      (historyEvent) => Date.parse(historyEvent.timestamp) < latestEventTime
    ) ||
    (
      await priceEventsCollection
        .find({
          symbol: event.symbol,
          timestamp: { $lt: latestEvent.timestamp },
        })
        .sort({ timestamp: -1, receivedAt: -1, _id: -1 })
        .limit(1)
        .toArray()
    )[0];
  const previousSnapshotPrice = precedingEvent?.price ?? null;
  const snapshotPercentChange = calculatePercentChange(
    previousSnapshotPrice,
    latestEvent.price
  );
  const previousPriceValue =
    precedingEvent === undefined
      ? { $ifNull: ["$previousPrice", null] }
      : { $literal: previousSnapshotPrice };
  const percentChangeValue =
    precedingEvent === undefined
      ? { $ifNull: ["$percentChange", 0] }
      : { $literal: Number(snapshotPercentChange.toFixed(4)) };
  const prices = recentEvents
    .slice(0, config.movingAverageWindow)
    .map((doc) => doc.price);
  const movingAverage = calculateMovingAverage(prices);
  const latestHistoryTime = recentEvents.length
    ? new Date(Date.parse(recentEvents[0].timestamp))
    : new Date(Date.parse(event.timestamp));
  const storedUpdatedAt = {
    $convert: {
      input: "$updatedAt",
      to: "date",
      onError: null,
      onNull: null,
    },
  };
  const shouldUpdateSnapshot = {
    $or: [
      { $eq: [storedUpdatedAt, null] },
      { $gte: [{ $literal: latestHistoryTime }, storedUpdatedAt] },
    ],
  };

  // Ties are ordered by first persisted time, then Kafka identity.
  const metricsUpdatePipeline = [
    {
      $set: {
        symbol: { $literal: event.symbol },
        latestPrice: {
          $cond: [
            shouldUpdateSnapshot,
            { $literal: latestEvent.price },
            "$latestPrice",
          ],
        },
        previousPrice: {
          $cond: [
            shouldUpdateSnapshot,
            previousPriceValue,
            "$previousPrice",
          ],
        },
        movingAverage: {
          $cond: [
            shouldUpdateSnapshot,
            { $literal: Number(movingAverage.toFixed(4)) },
            "$movingAverage",
          ],
        },
        percentChange: {
          $cond: [
            shouldUpdateSnapshot,
            percentChangeValue,
            "$percentChange",
          ],
        },
        updatedAt: {
          $cond: [
            shouldUpdateSnapshot,
            { $literal: latestEvent.timestamp },
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

  const maxEventsPerSymbol = config.maxEventsPerSymbol;
  const totalCount = await priceEventsCollection.countDocuments({
    symbol: event.symbol,
  });

  if (totalCount > maxEventsPerSymbol) {
    const excess = totalCount - maxEventsPerSymbol;
    const oldDocs = await priceEventsCollection
      .find({ symbol: event.symbol })
      .sort({ timestamp: 1, receivedAt: 1, _id: 1 })
      .limit(excess)
      .project({ _id: 1 })
      .toArray();
    const idsToDelete = oldDocs.map((doc) => doc._id);

    await priceEventsCollection.deleteMany({
      _id: { $in: idsToDelete },
    });

    console.log(`Cleaned ${idsToDelete.length} old events for ${event.symbol}`);
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
    latestPrice: latestEvent.price,
    previousPrice: previousSnapshotPrice,
    percentChange: Number(snapshotPercentChange.toFixed(4)),
    movingAverage: Number(movingAverage.toFixed(4)),
  });
}

async function startConsumer() {
  await ensureIndexes();
  await restoreAlertCooldowns();
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