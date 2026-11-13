const { Kafka } = require("kafkajs");
const { getDB } = require("./mongoClient");
const config = require("./config");
const { createProcessingTimings } = require("./processingTimings");
const { createAlertDecisionStore } = require("./alertDecisionStore");
const { createCommitReconciliation } = require("./commitReconciliation");
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

const consumerGroupId = "crypto-analytics-group";
const consumer = kafka.consumer({ groupId: consumerGroupId });
const livePriceTracker = createLivePriceTracker();
const processingTimings = config.processingTimings ? createProcessingTimings() : null;
let shuttingDown = false;
let activeMessages = 0;
let resolveDrain;
let processingFailedDuringShutdown = false;
let reconciliation;
let reconciliationListeners = [];

function beginConsumerShutdown() {
  shuttingDown = true;
  if (reconciliation) reconciliation.stopScheduling();
  for (const remove of reconciliationListeners) remove();
  reconciliationListeners = [];
}

function startReconciliation() {
  if (shuttingDown) return;
  if (reconciliation) throw new Error("Commit reconciliation is already initialized.");
  reconciliation = createCommitReconciliation({
    admin: kafka.admin(),
    collection: getDB().collection("alert_decisions"),
    groupId: consumerGroupId,
    topic: config.kafkaTopic,
  });
  reconciliationListeners.push(
    consumer.on(consumer.events.COMMIT_OFFSETS, () => reconciliation.schedule("commit"))
  );
  reconciliationListeners.push(
    consumer.on(consumer.events.GROUP_JOIN, () => reconciliation.schedule("group-join"))
  );
  reconciliation.start();
}

async function drainReconciliation() {
  if (reconciliation) await reconciliation.drain();
}

function waitForActiveMessages() {
  if (activeMessages === 0) return Promise.resolve();
  return new Promise((resolve) => { resolveDrain = resolve; });
}

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
  await db.collection("price_events").createIndex(
    { symbol: 1, timestamp: -1, receivedAt: 1, _id: 1 },
    { name: "price_symbol_timestamp_received_id" }
  );
  await db.collection("price_events").createIndex(
    { symbol: 1, timestamp: 1, receivedAt: 1, _id: 1 },
    { name: "price_symbol_timestamp_asc_received_id" }
  );
  await db.collection("alerts").createIndex(
    { timestamp: -1 },
    { name: "alerts_timestamp" }
  );
  await db.collection("alert_decisions").createIndex(
    { groupId: 1, topic: 1, partition: 1, offset: 1 },
    { name: "decision_group_topic_partition_offset" }
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
      {
        $group: {
          _id: "$symbol",
          latest: {
            $top: {
              sortBy: { eventTime: -1, _id: 1 },
              output: { timestamp: "$eventTime", eventId: "$_id" },
            },
          },
          invalidCount: {
            $sum: { $cond: [{ $eq: ["$eventTime", null] }, 1, 0] },
          },
        },
      },
      {
        $project: {
          timestamp: "$latest.timestamp",
          eventId: "$latest.eventId",
          invalidCount: 1,
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

async function restorePriceBaselines() {
  const collection = getDB().collection("price_events");
  const eventTime = {
    $convert: { input: "$timestamp", to: "date", onError: null, onNull: null },
  };
  const symbols = await collection.aggregate([
    { $match: { symbol: { $in: config.symbols } } },
    { $set: { eventTime } },
    {
      $group: {
        _id: "$symbol",
        latest: { $max: "$eventTime" },
        invalidCount: {
          $sum: { $cond: [{ $eq: ["$eventTime", null] }, 1, 0] },
        },
      },
    },
  ]).toArray();

  const latestBySymbol = new Map(symbols.map((entry) => [entry._id, entry]));
  for (const symbol of config.symbols) {
    const entry = latestBySymbol.get(symbol);
    if (!entry) {
      console.warn(`No persisted price history for ${symbol}; alert baselines require new events.`);
      continue;
    }
    if (entry.invalidCount > 0 || !entry.latest) {
      throw new Error(
        `Cannot restore price baseline for ${symbol}: persisted event timestamp is invalid.`
      );
    }

    const earliest = new Date(Math.max(
      -8640000000000000,
      entry.latest.getTime() - config.alertWindowMs - config.alertBaselineToleranceMs
    ));
    const history = collection.aggregate([
      { $match: { symbol } },
      { $set: { eventTime } },
      { $match: { eventTime: { $gte: earliest, $lte: entry.latest } } },
      { $sort: { eventTime: 1, receivedAt: 1, _id: 1 } },
      { $project: { symbol: 1, price: 1, timestamp: 1 } },
    ]);

    for await (const event of history) {
      const validationError = validateEvent(event);
      if (validationError) {
        throw new Error(
          `Cannot restore price baseline for ${symbol}: ${validationError} in persisted event ${event._id}.`
        );
      }
      livePriceTracker.recordPrice(symbol, event.price, event.timestamp, String(event._id));
    }

    if (!livePriceTracker.getBaseline(symbol, entry.latest.toISOString())) {
      console.warn(
        `Persisted price history for ${symbol} has no eligible baseline for its latest event; further events may be needed.`
      );
    }
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

async function processMessage(event, kafkaRecord, timing) {
  const db = getDB();

  const priceEventsCollection = db.collection("price_events");
  const metricsCollection = db.collection("metrics");
  const alertsCollection = db.collection("alerts");
  const decisionStore = createAlertDecisionStore(db.collection("alert_decisions"), consumerGroupId);
  const eventId = JSON.stringify([
    kafkaRecord.topic,
    kafkaRecord.partition,
    kafkaRecord.message.offset,
  ]);
  const identity = { _id: eventId };
  const kafkaIdentity = {
    topic: kafkaRecord.topic,
    partition: kafkaRecord.partition,
    offset: kafkaRecord.message.offset,
  };
  if (timing) timing.start("decisionPersistence");
  let decision = await decisionStore.find(kafkaIdentity);
  if (!decision) {
    const legacyEvent = await priceEventsCollection.findOne(identity);
    let originalDecision;
    if (legacyEvent && legacyEvent.alertCandidate !== undefined) {
      originalDecision = {
        alertCandidate: legacyEvent.alertCandidate,
        previousPrice: legacyEvent.previousPrice,
        percentChange: legacyEvent.percentChange,
      };
    } else {
      const baseline = livePriceTracker.getBaseline(event.symbol, event.timestamp);
      const previousPrice = baseline?.price ?? null;
      const percentChange = calculatePercentChange(previousPrice, event.price);
      const alertCandidate =
        baseline &&
        shouldCreateAlert(percentChange) &&
        !livePriceTracker.isOnCooldown(event.symbol, event.timestamp, eventId)
          ? buildAlert(
              event.symbol,
              percentChange,
              event.price,
              previousPrice,
              event.timestamp,
              new Date(baseline.timestamp).toISOString(),
              config.alertWindowMs
            )
          : null;
      originalDecision = { alertCandidate, previousPrice, percentChange };
    }
    decision = await decisionStore.insertOriginal(kafkaIdentity, originalDecision);
  }
  if (timing) timing.end();
  let storedEvent;

  if (timing) timing.start("rawPersistence");
  try {
    const result = await priceEventsCollection.updateOne(
      identity,
      {
        $setOnInsert: {
          symbol: event.symbol,
          price: event.price,
          timestamp: event.timestamp,
          receivedAt: new Date().toISOString(),
          previousPrice: decision.previousPrice,
          percentChange: decision.percentChange,
          alertCandidate: decision.alertCandidate,
        },
      },
      { upsert: true }
    );
    if (timing) timing.classify(result.upsertedCount === 1 ? "new" : "replay");
    storedEvent =
      result.upsertedCount === 1
        ? {
            previousPrice: decision.previousPrice,
            percentChange: decision.percentChange,
            alertCandidate: decision.alertCandidate,
          }
        : await priceEventsCollection.findOne(identity);
  } catch (error) {
    if (error.code !== 11000) throw error;

    if (timing) timing.classify("replay");
    storedEvent = await priceEventsCollection.findOne(identity);
    if (!storedEvent) throw error;
  }
  if (!storedEvent) {
    throw new Error(`Kafka event ${eventId} could not be loaded after persistence.`);
  }
  if (timing) timing.end();

  const alertCandidate = decision.alertCandidate;

  // Read history before retention pruning so the preceding event remains available.
  if (timing) timing.start("recentHistory");
  const recentEvents = await priceEventsCollection
    .find({ symbol: event.symbol })
    .sort({ timestamp: -1, receivedAt: 1, _id: 1 })
    .limit(Math.max(config.movingAverageWindow, 2))
    .toArray();
  if (timing) timing.end();

  const latestEvent = recentEvents[0] || event;
  const latestEventTime = Date.parse(latestEvent.timestamp);
  let precedingEvent = recentEvents.find(
    (historyEvent) => Date.parse(historyEvent.timestamp) < latestEventTime
  );
  if (!precedingEvent) {
    if (timing) timing.start("predecessor");
    precedingEvent = (
      await priceEventsCollection
        .find({
          symbol: event.symbol,
          timestamp: { $lt: latestEvent.timestamp },
        })
        .sort({ timestamp: -1, receivedAt: -1, _id: -1 })
        .limit(1)
        .toArray()
    )[0];
    if (timing) timing.end();
  }
  if (timing) timing.start("metricsCalculation");
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

  if (timing) timing.end();
  if (timing) timing.start("metricsPersistence");
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
  if (timing) timing.end();

  if (timing) timing.start("retentionQuery");
  const oldDocs = await priceEventsCollection
    .find({ symbol: event.symbol })
    .sort({ timestamp: -1, receivedAt: -1, _id: -1 })
    .skip(config.maxEventsPerSymbol)
    .project({ _id: 1 })
    .toArray();
  if (timing) timing.end();
  if (oldDocs.length > 0) {
    if (timing) timing.start("retentionDeletion");
    const result = await priceEventsCollection.deleteMany({
      symbol: event.symbol,
      _id: { $in: oldDocs.map((doc) => doc._id) },
    });
    if (timing) timing.end();
    console.log(`Cleaned ${result.deletedCount} old events for ${event.symbol}`);
  }

  if (alertCandidate) {
    let alertCreated = false;
    if (timing) timing.start("alertPersistence");
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
    if (timing) timing.end();

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
  if (shuttingDown) return;
  await restoreAlertCooldowns();
  if (shuttingDown) return;
  await restorePriceBaselines();
  if (shuttingDown) return;
  await consumer.connect();
  if (shuttingDown) return;
  console.log(`Consumer connected to Kafka at ${config.kafkaBroker}`);

  await consumer.subscribe({
    topic: config.kafkaTopic,
    fromBeginning: true,
  });
  if (shuttingDown) return;

  console.log(`Consumer subscribed to topic: ${config.kafkaTopic}`);

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      if (shuttingDown) {
        throw new Error("Consumer is shutting down; Kafka record was not processed.");
      }
      activeMessages += 1;
      try {
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

        const timing = processingTimings ? processingTimings.beginEvent() : null;
        try {
          await processMessage(event, { topic, partition, message }, timing);
          if (timing) timing.finish(true);
        } catch (error) {
          if (timing) timing.finish(false);
          throw error;
        }
      } catch (error) {
        if (shuttingDown) processingFailedDuringShutdown = true;
        throw error;
      } finally {
        activeMessages -= 1;
        if (activeMessages === 0 && resolveDrain) {
          resolveDrain();
          resolveDrain = undefined;
        }
      }
    },
  });
}

module.exports = {
  startConsumer,
  beginConsumerShutdown,
  stopConsumer: () => consumer.stop(),
  disconnectConsumer: () => consumer.disconnect(),
  waitForActiveMessages,
  hasShutdownProcessingFailure: () => processingFailedDuringShutdown,
  startReconciliation,
  drainReconciliation,
};