const mockConsumer = {
  connect: jest.fn(),
  subscribe: jest.fn(),
  run: jest.fn(),
  stop: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => ({
    consumer: jest.fn(() => mockConsumer),
  })),
}));

jest.mock("../src/mongoClient", () => ({
  getDB: () => global.__consumerIntegrationDB,
}));

const integrationUri = process.env.MONGO_INTEGRATION_URI;
const describeWithMongo = integrationUri ? describe : describe.skip;
const testDbName = `consumer_integration_${process.pid}_${Date.now()}`;

describeWithMongo("Kafka consumer MongoDB integration", () => {
  let client;
  let db;
  let eachMessage;
  let sequence = 0;

  beforeAll(async () => {
    process.env.MONGO_URI = integrationUri;
    process.env.DB_NAME = testDbName;

    const { MongoClient } = require("mongodb");
    client = new MongoClient(integrationUri, { monitorCommands: true });
    await client.connect();
    db = client.db(testDbName);
    global.__consumerIntegrationDB = db;
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
    delete global.__consumerIntegrationDB;
  });

  beforeEach(async () => {
    for (const name of ["price_events", "metrics", "alerts", "alert_decisions"]) {
      await db.collection(name).deleteMany({});
    }

    jest.resetModules();
    mockConsumer.connect.mockReset().mockResolvedValue();
    mockConsumer.subscribe.mockReset().mockResolvedValue();
    mockConsumer.run.mockReset().mockResolvedValue();
    mockConsumer.stop.mockReset().mockResolvedValue();
    mockConsumer.disconnect.mockReset().mockResolvedValue();

    const { startConsumer } = require("../src/kafkaConsumer");
    await startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
    sequence = 0;
  });

  function record(event, offset = String(sequence++), topic = "integration-topic") {
    return {
      topic,
      partition: 0,
      message: {
        value: Buffer.from(JSON.stringify(event)),
        offset,
      },
    };
  }

  function withCollectionOverride(name, overrideCollection) {
    global.__consumerIntegrationDB = {
      collection(collectionName) {
        const collection = db.collection(collectionName);
        return collectionName === name
          ? overrideCollection(collection)
          : collection;
      },
    };
  }

  function overrideMethod(collection, method, implementation) {
    return new Proxy(collection, {
      get(target, property) {
        if (property === method) return implementation;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("preserves a pruned late positive decision after alert failure and restart", async () => {
    require("../src/config").maxEventsPerSymbol = 2;
    const make = (offset, time, price) => record({
      symbol: "BTC-USD", price, timestamp: `2053-01-01T12:${time}.000Z`,
    }, offset);
    await eachMessage(make("900", "01:00", 100));
    await eachMessage(make("901", "02:05", 100));
    await eachMessage(make("902", "02:10", 100));
    const late = make("903", "02:00", 110);
    const id = JSON.stringify(["integration-topic", 0, "903"]);
    const failure = new Error("alert write failed after pruning");
    withCollectionOverride("alerts", (collection) =>
      overrideMethod(collection, "updateOne", jest.fn().mockRejectedValue(failure))
    );
    try {
      await expect(eachMessage(late)).rejects.toBe(failure);
      expect(await db.collection("price_events").findOne({ _id: id })).toBeNull();
      expect(await db.collection("alert_decisions").findOne({ _id: id }))
        .toMatchObject({ alertCandidate: { previousPrice: 100, currentPrice: 110, percentChange: 10 } });
      expect(await db.collection("metrics").findOne({ symbol: "BTC-USD" }))
        .toMatchObject({ latestPrice: 100, updatedAt: "2053-01-01T12:02:10.000Z" });
    } finally {
      global.__consumerIntegrationDB = db;
    }

    jest.resetModules();
    mockConsumer.run.mockClear();
    require("../src/config").maxEventsPerSymbol = 2;
    await require("../src/kafkaConsumer").startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
    await eachMessage(late);
    await eachMessage(late);
    expect(await db.collection("alerts").countDocuments({ _id: id })).toBe(1);
    expect(await db.collection("alerts").findOne({ _id: id }))
      .toMatchObject({ previousPrice: 100, currentPrice: 110, percentChange: 10 });
    expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(2);
    expect(await db.collection("price_events").findOne({ _id: id })).toBeNull();

    await eachMessage(make("904", "01:01", 100));
    await eachMessage(make("905", "02:01", 110));
    expect(await db.collection("alerts").countDocuments({ symbol: "BTC-USD" })).toBe(1);
  });

  it("preserves a pruned null decision even when a baseline later becomes available", async () => {
    require("../src/config").maxEventsPerSymbol = 2;
    const make = (offset, time, price) => record({
      symbol: "ETH-USD", price, timestamp: `2053-01-01T12:${time}.000Z`,
    }, offset);
    const late = make("910", "02:00", 110);
    const id = JSON.stringify(["integration-topic", 0, "910"]);
    await eachMessage(late);
    await eachMessage(make("911", "02:05", 100));
    await eachMessage(make("912", "02:10", 100));
    expect(await db.collection("price_events").findOne({ _id: id })).toBeNull();
    await eachMessage(make("913", "01:00", 100));
    await eachMessage(late);
    expect(await db.collection("alert_decisions").findOne({ _id: id }))
      .toMatchObject({ alertCandidate: null });
    expect(await db.collection("alerts").countDocuments({ symbol: "ETH-USD" })).toBe(0);
    expect(await db.collection("price_events").countDocuments({ symbol: "ETH-USD" })).toBe(2);
  });

  it.each([false, true])(
    "drains an active real-MongoDB callback during shutdown (write failure: %s)",
    async (failWrite) => {
      const { EventEmitter } = require("events");
      let releaseWrite;
      let notifyWrite;
      const waiting = new Promise((resolve) => { releaseWrite = resolve; });
      const entered = new Promise((resolve) => { notifyWrite = resolve; });
      const failure = new Error("shutdown metrics failure");
      withCollectionOverride("metrics", (collection) =>
        overrideMethod(collection, "updateOne", async (...args) => {
          notifyWrite();
          await waiting;
          if (failWrite) throw failure;
          return collection.updateOne(...args);
        })
      );
      const kafkaRecord = record({
        symbol: "BTC-USD", price: 100, timestamp: "2058-01-01T12:00:00.000Z",
      }, "550");
      const processing = eachMessage(kafkaRecord);
      const result = processing.then(() => null, (error) => error);
      await entered;

      const processObject = new EventEmitter();
      let resolveExit;
      const exited = new Promise((resolve) => { resolveExit = resolve; });
      processObject.exit = jest.fn(resolveExit);
      const close = jest.fn().mockResolvedValue();
      const lifecycle = require("../src/index").createLifecycle({
        processObject, connect: jest.fn().mockResolvedValue(),
        startKafka: jest.fn().mockResolvedValue(), close,
      });
      await lifecycle.start();
      processObject.emit("SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockConsumer.stop).toHaveBeenCalledTimes(1);
      expect(mockConsumer.disconnect).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      await expect(eachMessage(record({
        symbol: "ETH-USD", price: 200, timestamp: "2058-01-01T12:00:00.000Z",
      }, "551"))).rejects.toThrow("Kafka record was not processed");

      releaseWrite();
      expect(await result).toBe(failWrite ? failure : null);
      expect(await exited).toBe(failWrite ? 1 : 0);
      expect(mockConsumer.disconnect).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(1);

      global.__consumerIntegrationDB = db;
      if (failWrite) {
        jest.resetModules();
        mockConsumer.run.mockClear();
        await require("../src/kafkaConsumer").startConsumer();
        await mockConsumer.run.mock.calls[0][0].eachMessage(kafkaRecord);
        expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(1);
        expect(await db.collection("metrics").findOne({ symbol: "BTC-USD" }))
          .toMatchObject({ latestPrice: 100 });
      }
    }
  );

  it("retains the newest events per symbol and checks replay with one retention query", async () => {
    require("../src/config").maxEventsPerSymbol = 2;
    const priceEvents = db.collection("price_events");
    const commands = [];
    const listener = (command) => {
      if (command.databaseName === testDbName) commands.push(command);
    };
    const event = (symbol, price, timestamp, offset) =>
      record({ symbol, price, timestamp }, offset);
    const btcFirst = event("BTC-USD", 100, "2053-01-01T12:00:00.000Z", "501");
    const btcSecond = event("BTC-USD", 110, "2053-01-01T12:01:00.000Z", "502");
    const btcThird = event("BTC-USD", 120, "2053-01-01T12:02:00.000Z", "503");
    const ethFirst = event("ETH-USD", 200, "2053-01-01T12:00:00.000Z", "504");
    client.on("commandStarted", listener);

    async function processAndMeasure(kafkaRecord) {
      commands.length = 0;
      await eachMessage(kafkaRecord);
      return {
        scans: commands.filter((entry) =>
          entry.commandName === "find" &&
          entry.command.find === "price_events" &&
          entry.command.skip === 2
        ).length,
        counts: commands.filter((entry) =>
          entry.commandName === "count" ||
          (entry.commandName === "aggregate" && entry.command.aggregate === "price_events")
        ).length,
        deletes: commands.filter((entry) =>
          entry.commandName === "delete" && entry.command.delete === "price_events"
        ).length,
      };
    }

    try {
      expect(await processAndMeasure(btcFirst)).toEqual({ scans: 1, counts: 0, deletes: 0 });
      expect(await processAndMeasure(btcSecond)).toEqual({ scans: 1, counts: 0, deletes: 0 });
      expect(await processAndMeasure(ethFirst)).toEqual({ scans: 1, counts: 0, deletes: 0 });
      expect(await processAndMeasure(btcThird)).toEqual({ scans: 1, counts: 0, deletes: 1 });
      expect(await processAndMeasure(btcThird)).toEqual({ scans: 1, counts: 0, deletes: 0 });
      expect(await processAndMeasure(btcFirst)).toEqual({ scans: 1, counts: 0, deletes: 1 });
      expect(await priceEvents.find({ symbol: "BTC-USD" }).sort({ timestamp: 1 }).toArray())
        .toEqual([
          expect.objectContaining({ price: 110 }),
          expect.objectContaining({ price: 120 }),
        ]);
      expect(await priceEvents.countDocuments({ symbol: "ETH-USD" })).toBe(1);

      const late = event("BTC-USD", 90, "2053-01-01T11:59:00.000Z", "505");
      expect(await processAndMeasure(late)).toEqual({ scans: 1, counts: 0, deletes: 1 });
      expect(await priceEvents.find({ symbol: "BTC-USD" }).sort({ timestamp: 1 }).toArray())
        .toEqual([
          expect.objectContaining({ price: 110 }),
          expect.objectContaining({ price: 120 }),
        ]);
      expect(await db.collection("metrics").findOne({ symbol: "BTC-USD" })).toMatchObject({
        latestPrice: 120,
        updatedAt: "2053-01-01T12:02:00.000Z",
      });
    } finally {
      client.removeListener("commandStarted", listener);
    }
  });

  it("prunes equal timestamps using receivedAt and then _id without touching other symbols", async () => {
    require("../src/config").maxEventsPerSymbol = 2;
    const prices = db.collection("price_events");
    const timestamp = "2054-01-01T12:00:00.000Z";
    await prices.insertMany([
      { _id: "tie-a", symbol: "BTC-USD", price: 100, timestamp, receivedAt: "2054-01-01T12:00:01.000Z" },
      { _id: "tie-b", symbol: "BTC-USD", price: 101, timestamp, receivedAt: "2054-01-01T12:00:01.000Z" },
      { _id: "tie-c", symbol: "BTC-USD", price: 102, timestamp, receivedAt: "2054-01-01T12:00:02.000Z" },
      { _id: "other", symbol: "ETH-USD", price: 200, timestamp, receivedAt: "2054-01-01T12:00:00.000Z" },
    ]);

    await eachMessage(record({
      symbol: "BTC-USD",
      price: 90,
      timestamp: "2054-01-01T11:59:00.000Z",
    }, "510"));

    expect((await prices.find({ symbol: "BTC-USD" }).sort({ _id: 1 }).toArray())
      .map((item) => item._id)).toEqual(["tie-b", "tie-c"]);
    expect(await prices.findOne({ _id: "other" })).toMatchObject({ symbol: "ETH-USD" });
  });

  it("retries retention after a delete failure without duplicating raw history", async () => {
    require("../src/config").maxEventsPerSymbol = 1;
    const first = record({
      symbol: "BTC-USD", price: 100, timestamp: "2055-01-01T12:00:00.000Z",
    }, "520");
    const second = record({
      symbol: "BTC-USD", price: 110, timestamp: "2055-01-01T12:01:00.000Z",
    }, "521");
    await eachMessage(first);
    const failure = new Error("temporary retention failure");
    withCollectionOverride("price_events", (collection) =>
      overrideMethod(collection, "deleteMany", jest.fn().mockRejectedValue(failure))
    );

    try {
      await expect(eachMessage(second)).rejects.toBe(failure);
      expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(2);
      expect(await db.collection("metrics").findOne({ symbol: "BTC-USD" })).toMatchObject({
        latestPrice: 110, previousPrice: 100, percentChange: 10,
      });
    } finally {
      global.__consumerIntegrationDB = db;
    }

    await eachMessage(second);
    expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(1);
    expect(await db.collection("price_events").findOne({ symbol: "BTC-USD" }))
      .toMatchObject({ price: 110 });
  });

  it("retries retention after a read failure without duplicating raw history", async () => {
    require("../src/config").maxEventsPerSymbol = 1;
    const first = record({
      symbol: "ETH-USD", price: 100, timestamp: "2056-01-01T12:00:00.000Z",
    }, "530");
    const second = record({
      symbol: "ETH-USD", price: 110, timestamp: "2056-01-01T12:01:00.000Z",
    }, "531");
    await eachMessage(first);
    const failure = new Error("temporary retention read failure");
    withCollectionOverride("price_events", (collection) =>
      overrideMethod(collection, "find", (filter) => {
        const cursor = collection.find(filter);
        if (filter.symbol && !filter.timestamp) {
          const skip = cursor.skip.bind(cursor);
          cursor.skip = (value) => {
            skip(value);
            cursor.toArray = jest.fn().mockRejectedValue(failure);
            return cursor;
          };
        }
        return cursor;
      })
    );

    try {
      await expect(eachMessage(second)).rejects.toBe(failure);
      expect(await db.collection("price_events").countDocuments({ symbol: "ETH-USD" })).toBe(2);
      expect(await db.collection("metrics").findOne({ symbol: "ETH-USD" }))
        .toMatchObject({ latestPrice: 110, previousPrice: 100 });
    } finally {
      global.__consumerIntegrationDB = db;
    }

    await eachMessage(second);
    expect(await db.collection("price_events").countDocuments({ symbol: "ETH-USD" })).toBe(1);
    expect(await db.collection("price_events").findOne({ symbol: "ETH-USD" }))
      .toMatchObject({ price: 110 });
  });

  it("accepts the largest configured retention cap", async () => {
    require("../src/config").maxEventsPerSymbol = Number.MAX_SAFE_INTEGER;
    await eachMessage(record({
      symbol: "SOL-USD", price: 100, timestamp: "2057-01-01T12:00:00.000Z",
    }, "540"));
    expect(await db.collection("price_events").countDocuments({ symbol: "SOL-USD" })).toBe(1);
  });

  it("creates non-unique history and alert indexes and preserves identity uniqueness", async () => {
    const priceIndexes = await db.collection("price_events").listIndexes().toArray();
    const alertIndexes = await db.collection("alerts").listIndexes().toArray();
    const metricsIndexes = await db.collection("metrics").listIndexes().toArray();

    expect(priceIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "_id_", key: { _id: 1 } }),
      expect.objectContaining({
        name: "price_symbol_timestamp_received_id",
        key: { symbol: 1, timestamp: -1, receivedAt: 1, _id: 1 },
      }),
      expect.objectContaining({
        name: "price_symbol_timestamp_asc_received_id",
        key: { symbol: 1, timestamp: 1, receivedAt: 1, _id: 1 },
      }),
    ]));
    expect(priceIndexes.find((index) => index.name === "price_symbol_timestamp_received_id").unique)
      .not.toBe(true);
    expect(priceIndexes.find((index) => index.name === "price_symbol_timestamp_asc_received_id").unique)
      .not.toBe(true);
    expect(alertIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "_id_", key: { _id: 1 } }),
      expect.objectContaining({ name: "alerts_timestamp", key: { timestamp: -1 } }),
    ]));
    expect(alertIndexes.find((index) => index.name === "alerts_timestamp").unique)
      .not.toBe(true);
    expect(metricsIndexes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "unique_metrics_symbol",
        key: { symbol: 1 },
        unique: true,
      }),
    ]));
  });

  it("uses the history and alert indexes for representative query plans", async () => {
    const priceEvents = Array.from({ length: 600 }, (_, index) => ({
      _id: `plan-price-${index}`,
      symbol: index % 2 === 0 ? "BTC-USD" : "ETH-USD",
      price: 100 + index,
      timestamp: new Date(Date.UTC(2052, 0, 1, 0, 0, index)).toISOString(),
      receivedAt: new Date(Date.UTC(2052, 0, 1, 0, 0, index)).toISOString(),
    }));
    const alerts = priceEvents.map(({ _id, symbol, timestamp }) => ({
      _id: `alert-${_id}`,
      symbol,
      timestamp,
    }));
    await db.collection("price_events").insertMany(priceEvents);
    await db.collection("alerts").insertMany(alerts);

    function planSummary(explanation) {
      const stages = [];
      const indexes = [];
      function visit(value) {
        if (!value || typeof value !== "object") return;
        if (typeof value.stage === "string") stages.push(value.stage);
        if (typeof value.indexName === "string") indexes.push(value.indexName);
        for (const child of Object.values(value)) visit(child);
      }
      visit(explanation.queryPlanner.winningPlan);
      return { stages, indexes };
    }

    const prices = db.collection("price_events");
    const metrics = db.collection("metrics");
    const threshold = "2052-01-01T00:05:00.000Z";
    await metrics.insertOne({ symbol: "BTC-USD", latestPrice: 100 });
    const config = require("../src/config");
    const restoredTime = {
      $convert: { input: "$timestamp", to: "date", onError: null, onNull: null },
    };
    const baselinePipeline = [
      { $match: { symbol: "BTC-USD" } },
      { $set: { eventTime: restoredTime } },
      { $match: { eventTime: {
        $gte: new Date("2052-01-01T00:04:00.000Z"),
        $lte: new Date("2052-01-01T00:05:00.000Z"),
      } } },
      { $sort: { eventTime: 1, receivedAt: 1, _id: 1 } },
      { $project: { symbol: 1, price: 1, timestamp: 1 } },
    ];
    const previousCooldownPipeline = [
      { $match: { symbol: { $in: config.symbols } } },
      { $set: { eventTime: restoredTime } },
      { $sort: { eventTime: -1, _id: 1 } },
      { $group: {
        _id: "$symbol",
        timestamp: { $first: "$eventTime" },
        eventId: { $first: "$_id" },
        invalidCount: { $sum: { $cond: [{ $eq: ["$eventTime", null] }, 1, 0] } },
      } },
    ];
    const cooldownPipeline = [
      { $match: { symbol: { $in: config.symbols } } },
      { $set: { eventTime: restoredTime } },
      { $group: {
        _id: "$symbol",
        latest: { $top: {
          sortBy: { eventTime: -1, _id: 1 },
          output: { timestamp: "$eventTime", eventId: "$_id" },
        } },
        invalidCount: { $sum: { $cond: [{ $eq: ["$eventTime", null] }, 1, 0] } },
      } },
      { $project: {
        timestamp: "$latest.timestamp", eventId: "$latest.eventId", invalidCount: 1,
      } },
    ];
    const plans = {
      history: await prices.find({ symbol: "BTC-USD" })
        .sort({ timestamp: -1 }).limit(10).explain("executionStats"),
      analytics: await prices.find({ symbol: "BTC-USD" })
        .sort({ timestamp: -1, receivedAt: 1, _id: 1 }).limit(5).explain("executionStats"),
      predecessor: await prices.find({ symbol: "BTC-USD", timestamp: { $lt: threshold } })
        .sort({ timestamp: -1, receivedAt: -1, _id: -1 }).limit(1).explain("executionStats"),
      retention: await prices.find({ symbol: "BTC-USD" })
        .sort({ timestamp: -1, receivedAt: -1, _id: -1 })
        .skip(295).project({ _id: 1 }).explain("executionStats"),
      alerts: await db.collection("alerts").find({}, { projection: { _id: 0 } })
        .sort({ timestamp: -1 }).limit(10).explain("executionStats"),
      metrics: await metrics.find({}, { projection: { _id: 0 } })
        .sort({ symbol: 1 }).explain("executionStats"),
    };
    const baselineExplain = await prices.aggregate(baselinePipeline).explain("executionStats");
    const previousCooldownExplain = await db.collection("alerts")
      .aggregate(previousCooldownPipeline).explain("executionStats");
    const cooldownExplain = await db.collection("alerts").aggregate(cooldownPipeline)
      .explain("executionStats");
    const sortBySymbol = (a, b) => a._id.localeCompare(b._id);
    expect((await db.collection("alerts").aggregate(cooldownPipeline).toArray()).sort(sortBySymbol))
      .toEqual((await db.collection("alerts").aggregate(previousCooldownPipeline).toArray())
        .sort(sortBySymbol));
    expect(previousCooldownExplain.stages.some((stage) => stage.$sort)).toBe(true);
    expect(cooldownExplain.stages.some((stage) => stage.$sort)).toBe(false);

    for (const name of ["history", "analytics"]) {
      expect(planSummary(plans[name]).indexes).toContain("price_symbol_timestamp_received_id");
    }
    for (const name of ["predecessor", "retention"]) {
      expect(planSummary(plans[name]).indexes).toContain("price_symbol_timestamp_asc_received_id");
      expect(planSummary(plans[name]).stages).not.toContain("SORT");
    }
    expect(plans.retention.executionStats.nReturned).toBe(5);
    expect(plans.retention.executionStats.totalKeysExamined).toBeGreaterThanOrEqual(300);
    expect(plans.retention.executionStats.totalDocsExamined).toBe(0);
    expect(planSummary(plans.history).stages).not.toContain("SORT");
    expect(planSummary(plans.analytics).stages).not.toContain("SORT");
    expect(planSummary(plans.alerts).indexes).toContain("alerts_timestamp");
    expect(planSummary(plans.alerts).stages).not.toContain("SORT");
    expect(planSummary(plans.metrics).indexes).toContain("unique_metrics_symbol");
    console.log("MongoDB query plans:", Object.fromEntries(
      Object.entries(plans).map(([name, plan]) => [name, {
        ...planSummary(plan),
        examinedKeys: plan.executionStats.totalKeysExamined,
        examinedDocuments: plan.executionStats.totalDocsExamined,
        returned: plan.executionStats.nReturned,
      }])
    ));
    for (const [name, explanation] of [
      ["baseline restoration", baselineExplain],
      ["previous cooldown restoration", previousCooldownExplain],
      ["cooldown restoration", cooldownExplain],
    ]) {
      const cursor = explanation.stages.find((stage) => stage.$cursor).$cursor;
      console.log(`${name} plan:`, {
        ...planSummary(cursor),
        pipelineStages: explanation.stages.map((stage) => Object.keys(stage)[0]),
        examinedKeys: cursor.executionStats.totalKeysExamined,
        examinedDocuments: cursor.executionStats.totalDocsExamined,
      });
    }
  });

  it("uses the same baseline decision after restart as an uninterrupted consumer", async () => {
    const time = "2049-01-01T12:00:00.000Z";
    await eachMessage(record({ symbol: "BTC-USD", price: 100, timestamp: time }, "400"));
    await eachMessage(record({ symbol: "ETH-USD", price: 100, timestamp: time }, "401"));
    await eachMessage(record({
      symbol: "BTC-USD", price: 102, timestamp: "2049-01-01T12:01:00.000Z",
    }, "402"));
    const uninterrupted = await db.collection("alerts").findOne({ symbol: "BTC-USD" });
    expect(uninterrupted).toMatchObject({ previousPrice: 100, percentChange: 2 });
    const pricesBefore = await db.collection("price_events").countDocuments();
    const alertsBefore = await db.collection("alerts").countDocuments();

    jest.resetModules();
    mockConsumer.run.mockClear();
    await require("../src/kafkaConsumer").startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
    expect(await db.collection("price_events").countDocuments()).toBe(pricesBefore);
    expect(await db.collection("alerts").countDocuments()).toBe(alertsBefore);

    await eachMessage(record({
      symbol: "ETH-USD", price: 102, timestamp: "2049-01-01T12:01:00.000Z",
    }, "403"));
    expect(await db.collection("alerts").findOne({ symbol: "ETH-USD" })).toMatchObject({
      previousPrice: uninterrupted.previousPrice,
      percentChange: uninterrupted.percentChange,
      comparisonTimestamp: uninterrupted.comparisonTimestamp,
    });
  });

  it("restores out-of-order and equal timestamps deterministically without using future baselines", async () => {
    const history = [
      { _id: "late", symbol: "SOL-USD", price: 999, timestamp: "2051-01-01T12:00:30.000Z", receivedAt: "2051-01-01T12:02:00.000Z" },
      { _id: "second", symbol: "SOL-USD", price: 101, timestamp: "2051-01-01T14:00:00.000+02:00", receivedAt: "2051-01-01T12:01:01.000Z" },
      { _id: "first", symbol: "SOL-USD", price: 100, timestamp: "2051-01-01T12:00:00.000Z", receivedAt: "2051-01-01T12:01:00.000Z" },
    ];
    await db.collection("price_events").insertMany(history);

    jest.resetModules();
    mockConsumer.run.mockClear();
    await require("../src/kafkaConsumer").startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
    expect(await db.collection("alerts").countDocuments()).toBe(0);
    expect(await db.collection("price_events").countDocuments()).toBe(3);

    await eachMessage(record({
      symbol: "SOL-USD", price: 103, timestamp: "2051-01-01T12:01:00.000Z",
    }, "410"));
    expect(await db.collection("alerts").findOne({ symbol: "SOL-USD" })).toMatchObject({
      previousPrice: 101,
      comparisonTimestamp: "2051-01-01T12:00:00.000Z",
      percentChange: 1.9802,
    });
  });

  it("restores equal-time cooldowns using the lowest identity and converted event time", async () => {
    await db.collection("alerts").insertMany([
      { _id: "z", symbol: "BTC-USD", timestamp: "2048-01-01T14:08:00+02:00" },
      { _id: "a", symbol: "BTC-USD", timestamp: "2048-01-01T12:08:00.000Z" },
      { _id: "old", symbol: "BTC-USD", timestamp: "2048-01-01T12:07:00.000Z" },
      { _id: "eth", symbol: "ETH-USD", timestamp: new Date("2048-01-01T12:03:00.000Z") },
    ]);

    jest.resetModules();
    const analytics = require("../src/analytics");
    const tracker = analytics.createLivePriceTracker();
    jest.spyOn(analytics, "createLivePriceTracker").mockReturnValue(tracker);
    mockConsumer.run.mockClear();
    await require("../src/kafkaConsumer").startConsumer();

    expect(tracker.isOnCooldown("BTC-USD", "2048-01-01T12:09:00Z", "a")).toBe(false);
    expect(tracker.isOnCooldown("BTC-USD", "2048-01-01T12:09:00Z", "z")).toBe(true);
    expect(tracker.isOnCooldown("ETH-USD", "2048-01-01T12:07:59Z")).toBe(true);
    expect(tracker.isOnCooldown("ETH-USD", "2048-01-01T12:08:00Z")).toBe(false);
  });

  it("restores the latest per-symbol cooldown after restart and ignores an older replay", async () => {
    const btcEvents = [
      { symbol: "BTC-USD", price: 100, timestamp: "2048-01-01T12:00:00.000Z" },
      { symbol: "BTC-USD", price: 100, timestamp: "2048-01-01T12:01:00.000Z" },
      { symbol: "BTC-USD", price: 101, timestamp: "2048-01-01T12:02:00.000Z" },
      { symbol: "BTC-USD", price: 100, timestamp: "2048-01-01T12:07:00.000Z" },
      { symbol: "BTC-USD", price: 101, timestamp: "2048-01-01T12:08:00.000Z" },
    ];
    const btcRecords = btcEvents.map((event, index) =>
      record(event, String(300 + index))
    );
    for (const kafkaRecord of btcRecords) await eachMessage(kafkaRecord);
    expect(await db.collection("alerts").countDocuments({ symbol: "BTC-USD" })).toBe(2);

    await db.collection("alerts").insertMany([
      { _id: "eth-older", symbol: "ETH-USD", timestamp: "2048-01-01T14:03:00+02:00" },
      { _id: "eth-newer", symbol: "ETH-USD", timestamp: "2048-01-01T12:08:00.250Z" },
    ]);

    jest.resetModules();
    mockConsumer.run.mockClear();
    await require("../src/kafkaConsumer").startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;

    await eachMessage(btcRecords[2]);
    await eachMessage(btcRecords[4]);
    await eachMessage(record(
      { symbol: "BTC-USD", price: 102, timestamp: "2048-01-01T12:09:00.000Z" },
      "305"
    ));

    await eachMessage(record(
      { symbol: "ETH-USD", price: 100, timestamp: "2048-01-01T12:08:30.000Z" },
      "306"
    ));
    await eachMessage(record(
      { symbol: "ETH-USD", price: 102, timestamp: "2048-01-01T12:09:30.000Z" },
      "307"
    ));

    await eachMessage(record(
      { symbol: "SOL-USD", price: 100, timestamp: "2048-01-01T12:08:00.000Z" },
      "308"
    ));
    await eachMessage(record(
      { symbol: "SOL-USD", price: 102, timestamp: "2048-01-01T12:09:00.000Z" },
      "309"
    ));

    expect(await db.collection("alerts").countDocuments({ symbol: "BTC-USD" })).toBe(2);
    expect(await db.collection("alerts").countDocuments({ symbol: "ETH-USD" })).toBe(2);
    expect(await db.collection("alerts").countDocuments({ symbol: "SOL-USD" })).toBe(1);

    await eachMessage(record(
      { symbol: "BTC-USD", price: 100, timestamp: "2048-01-01T12:12:00.000Z" },
      "310"
    ));
    await eachMessage(record(
      { symbol: "BTC-USD", price: 102, timestamp: "2048-01-01T12:13:00.000Z" },
      "311"
    ));
    expect(await db.collection("alerts").countDocuments({ symbol: "BTC-USD" })).toBe(3);
  });

  it("refuses startup when a supported symbol has an invalid persisted alert timestamp", async () => {
    await db.collection("alerts").insertMany([
      { _id: "valid-alert", symbol: "BTC-USD", timestamp: "2048-01-01T12:08:00.000Z" },
      { _id: "invalid-alert", symbol: "BTC-USD", timestamp: "invalid" },
    ]);
    jest.resetModules();
    mockConsumer.connect.mockClear();
    mockConsumer.run.mockClear();

    await expect(require("../src/kafkaConsumer").startConsumer()).rejects.toThrow(
      "Cannot restore alert cooldown for BTC-USD: persisted alert timestamp is invalid."
    );
    expect(mockConsumer.connect).not.toHaveBeenCalled();
    expect(mockConsumer.run).not.toHaveBeenCalled();
  });

  it("creates the unique metrics index and persists replay/distinct records correctly", async () => {
    const indexes = await db.collection("metrics").listIndexes().toArray();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "unique_metrics_symbol",
          unique: true,
          key: { symbol: 1 },
        }),
      ])
    );

    const first = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2035-01-01T12:00:00.000Z",
    };
    const second = { ...first, price: 100 };
    const firstRecord = record(first, "10");

    await eachMessage(firstRecord);
    await eachMessage(firstRecord);
    await eachMessage(record(second, "11"));

    expect(await db.collection("price_events").countDocuments({ symbol: first.symbol })).toBe(2);
    expect(await db.collection("metrics").countDocuments({ symbol: first.symbol })).toBe(1);
    expect(await db.collection("metrics").findOne({ symbol: first.symbol })).toMatchObject({
      latestPrice: 100,
      movingAverage: 100,
      updatedAt: first.timestamp,
    });
  });

  it("keeps the newest snapshot after a late older event and refreshes the history average", async () => {
    const events = [
      { symbol: "ETH-USD", price: 100, timestamp: "2036-01-01T12:00:00.000Z" },
      { symbol: "ETH-USD", price: 110, timestamp: "2036-01-01T12:01:00.000Z" },
      { symbol: "ETH-USD", price: 105, timestamp: "2036-01-01T12:00:30.000Z" },
    ];

    for (const event of events) await eachMessage(record(event));

    expect(await db.collection("metrics").findOne({ symbol: "ETH-USD" })).toMatchObject({
      latestPrice: 110,
      previousPrice: 105,
      movingAverage: 105,
      percentChange: 4.7619,
      updatedAt: events[1].timestamp,
    });
  });

  it("replays after a real raw insert and an injected metrics failure", async () => {
    const originalUpdateOne = db.collection("metrics").updateOne.bind(db.collection("metrics"));
    let failed = false;
    withCollectionOverride(
      "metrics",
      (collection) =>
        overrideMethod(collection, "updateOne", async (...args) => {
          if (!failed) {
            failed = true;
            throw new Error("injected metrics failure");
          }
          return originalUpdateOne(...args);
        })
    );

    const event = {
      symbol: "SOL-USD",
      price: 150,
      timestamp: "2037-01-01T12:00:00.000Z",
    };
    const kafkaRecord = record(event, "50");

    await expect(eachMessage(kafkaRecord)).rejects.toThrow("injected metrics failure");
    global.__consumerIntegrationDB = db;
    await eachMessage(kafkaRecord);

    expect(await db.collection("price_events").countDocuments({ symbol: event.symbol })).toBe(1);
    expect(await db.collection("metrics").findOne({ symbol: event.symbol })).toMatchObject({
      latestPrice: 150,
      movingAverage: 150,
      updatedAt: event.timestamp,
    });
  });

  it("repairs latest previous-price metrics after the confirmed partial-write replay sequence", async () => {
    const originalUpdateOne = db.collection("metrics").updateOne.bind(db.collection("metrics"));
    let armed = false;
    let failed = false;
    withCollectionOverride(
      "metrics",
      (collection) =>
        overrideMethod(collection, "updateOne", async (...args) => {
          if (armed && !failed) {
            failed = true;
            throw new Error("injected 12:01 metrics failure");
          }
          return originalUpdateOne(...args);
        })
    );

    const events = [
      { symbol: "BTC-USD", price: 100, timestamp: "2045-01-01T12:00:00.000Z" },
      { symbol: "BTC-USD", price: 110, timestamp: "2045-01-01T12:01:00.000Z" },
      { symbol: "BTC-USD", price: 120, timestamp: "2045-01-01T12:02:00.000Z" },
    ];
    const records = events.map((event, index) =>
      record(event, String(80 + index))
    );

    await eachMessage(records[0]);
    armed = true;
    await expect(eachMessage(records[1])).rejects.toThrow(
      "injected 12:01 metrics failure"
    );
    global.__consumerIntegrationDB = db;
    await eachMessage(records[2]);

    expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(3);
    expect(await db.collection("metrics").findOne({ symbol: "BTC-USD" })).toMatchObject({
      latestPrice: 120,
      previousPrice: 110,
      percentChange: 9.0909,
      updatedAt: events[2].timestamp,
    });

    await eachMessage(records[1]);

    expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(3);
    expect(await db.collection("metrics").findOne({ symbol: "BTC-USD" })).toMatchObject({
      latestPrice: 120,
      previousPrice: 110,
      percentChange: 9.0909,
      updatedAt: events[2].timestamp,
    });
  });

  it("preserves derived snapshot values when retention has pruned the prior raw event", async () => {
    require("../src/config").maxEventsPerSymbol = 1;
    const events = [
      { symbol: "ETH-USD", price: 100, timestamp: "2046-01-01T12:00:00.000Z" },
      { symbol: "ETH-USD", price: 110, timestamp: "2046-01-01T12:01:00.000Z" },
    ];
    const records = events.map((event, index) =>
      record(event, String(90 + index))
    );

    await eachMessage(records[0]);
    await eachMessage(records[1]);
    expect(await db.collection("price_events").countDocuments({ symbol: "ETH-USD" })).toBe(1);

    await eachMessage(records[1]);

    expect(await db.collection("metrics").findOne({ symbol: "ETH-USD" })).toMatchObject({
      latestPrice: 110,
      previousPrice: 100,
      percentChange: 10,
      updatedAt: events[1].timestamp,
    });
  });

  it("recovers an alert write after metrics committed without duplicating raw history or alerts", async () => {
    const originalUpdateOne = db.collection("alerts").updateOne.bind(db.collection("alerts"));
    let failed = false;
    withCollectionOverride(
      "alerts",
      (collection) =>
        overrideMethod(collection, "updateOne", async (...args) => {
          if (!failed) {
            failed = true;
            throw new Error("injected alert failure");
          }
          return originalUpdateOne(...args);
        })
    );

    const events = [
      { symbol: "BTC-USD", price: 100, timestamp: "2038-01-01T12:00:00.000Z" },
      { symbol: "BTC-USD", price: 100, timestamp: "2038-01-01T12:01:00.000Z" },
      { symbol: "BTC-USD", price: 102, timestamp: "2038-01-01T12:02:00.000Z" },
    ];
    await eachMessage(record(events[0], "60"));
    await eachMessage(record(events[1], "61"));
    const spikeRecord = record(events[2], "62");

    await expect(eachMessage(spikeRecord)).rejects.toThrow("injected alert failure");
    global.__consumerIntegrationDB = db;
    await eachMessage(spikeRecord);

    expect(await db.collection("price_events").countDocuments({ symbol: "BTC-USD" })).toBe(3);
    expect(await db.collection("alerts").countDocuments({ symbol: "BTC-USD" })).toBe(1);
    expect(await db.collection("alerts").findOne({ symbol: "BTC-USD" })).toMatchObject({
      percentChange: 2,
      timestamp: events[2].timestamp,
    });
  });

  it("serializes concurrent first-time metrics upserts with the unique index", async () => {
    const events = [
      { symbol: "SOL-USD", price: 150, timestamp: "2039-01-01T12:00:00.000Z" },
      { symbol: "SOL-USD", price: 160, timestamp: "2039-01-01T12:01:00.000Z" },
    ];

    await Promise.all(events.map((event, index) => eachMessage(record(event, String(70 + index)))));

    expect(await db.collection("metrics").countDocuments({ symbol: "SOL-USD" })).toBe(1);
    expect(await db.collection("metrics").findOne({ symbol: "SOL-USD" })).toMatchObject({
      latestPrice: 160,
      updatedAt: events[1].timestamp,
    });
    expect(await db.collection("price_events").countDocuments({ symbol: "SOL-USD" })).toBe(2);
  });

  it("does not generate another alert after replaying an older alert record", async () => {
    const events = [
      { symbol: "BTC-USD", price: 100, timestamp: "2040-01-01T12:00:00.000Z" },
      { symbol: "BTC-USD", price: 100, timestamp: "2040-01-01T12:01:00.000Z" },
      { symbol: "BTC-USD", price: 101, timestamp: "2040-01-01T12:02:00.000Z" },
      { symbol: "BTC-USD", price: 100, timestamp: "2040-01-01T12:06:00.000Z" },
      { symbol: "BTC-USD", price: 100, timestamp: "2040-01-01T12:07:00.000Z" },
      { symbol: "BTC-USD", price: 101, timestamp: "2040-01-01T12:08:00.000Z" },
    ];
    const records = events.map((event, index) =>
      record(event, String(200 + index))
    );

    for (const kafkaRecord of records) await eachMessage(kafkaRecord);
    await eachMessage(records[2]);
    await eachMessage(
      record(
        { symbol: "BTC-USD", price: 102, timestamp: "2040-01-01T12:09:00.000Z" },
        "206"
      )
    );

    expect(await db.collection("alerts").countDocuments({ symbol: "BTC-USD" })).toBe(2);
    expect(await db.collection("alerts").find({ symbol: "BTC-USD" }).sort({ timestamp: 1 }).toArray())
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ timestamp: events[2].timestamp }),
          expect.objectContaining({ timestamp: events[5].timestamp }),
        ])
      );
  });

});
