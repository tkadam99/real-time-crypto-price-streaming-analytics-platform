const {
  captureAnalyticsCallback,
  createMeasurements,
  createOperationTimings,
  intervalUnionDuration,
  payload,
  percentile,
  summarizeSendAndCommit,
  trackConsumerReadiness,
  validateEnvironment,
  verifyBacklog,
  verifyIdentities,
} = require("./analyticsBenchmark");
const { EventEmitter } = require("node:events");

const safeEnv = {
  RUN_DISPOSABLE_ANALYTICS_BENCHMARK: "true",
  ALLOW_DESTRUCTIVE_INTEGRATION_TESTS: "true",
  KAFKA_INTEGRATION_BROKER: "127.0.0.1:9092",
  MONGO_INTEGRATION_URI: "mongodb://127.0.0.1:27017",
};

function record(offset) {
  return { topic: "test-topic", partition: 0, message: { offset: String(offset) } };
}

describe("analytics benchmark safety", () => {
  test("requires explicit benchmark and destructive-operation opt-ins", () => {
    expect(() => validateEnvironment({ ...safeEnv, RUN_DISPOSABLE_ANALYTICS_BENCHMARK: "" }))
      .toThrow("RUN_DISPOSABLE_ANALYTICS_BENCHMARK");
    expect(() => validateEnvironment({ ...safeEnv, ALLOW_DESTRUCTIVE_INTEGRATION_TESTS: "" }))
      .toThrow("ALLOW_DESTRUCTIVE_INTEGRATION_TESTS");
  });

  test.each(["KAFKA_INTEGRATION_BROKER", "MONGO_INTEGRATION_URI"])(
    "rejects a missing %s before connections", (name) => {
      expect(() => validateEnvironment({ ...safeEnv, [name]: "" })).toThrow("are required");
    }
  );

  test.each([
    { KAFKA_INTEGRATION_BROKER: "remote.example:9092" },
    { KAFKA_INTEGRATION_BROKER: "127.0.0.1:9092,127.0.0.1:9093" },
    { MONGO_INTEGRATION_URI: "mongodb://remote.example:27017" },
    { MONGO_INTEGRATION_URI: "mongodb://127.0.0.1:27017/crypto_analytics" },
    { MONGO_INTEGRATION_URI: "mongodb://user:password@127.0.0.1:27017" },
  ])("rejects unsafe resource configuration: %j", (override) => {
    expect(() => validateEnvironment({ ...safeEnv, ...override })).toThrow();
  });

  test("captures the actual callback with fake Kafka and a mock database", async () => {
    const collection = {
      createIndex: jest.fn().mockResolvedValue("index"),
      aggregate: jest.fn(() => ({ toArray: async () => [] })),
    };
    const db = { databaseName: "test_database", collection: jest.fn(() => collection) };
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { callback, config } = await captureAnalyticsCallback(db, "test-topic", "127.0.0.1:9092");
      expect(typeof callback).toBe("function");
      expect(config.kafkaTopic).toBe("test-topic");
      expect(config.decisionCleanupEnabled).toBe(false);
      await expect(callback({ message: { value: null } })).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  test("runs the real analytics processing callback against mock collections", async () => {
    let rawDocument;
    const emptyCursor = () => ({
      sort() { return this; },
      limit() { return this; },
      skip() { return this; },
      project() { return this; },
      async toArray() { return []; },
    });
    const common = {
      createIndex: jest.fn().mockResolvedValue("index"),
      aggregate: jest.fn(() => ({ toArray: async () => [] })),
    };
    const decisions = {
      ...common,
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn(async (_filter, update) => update.$setOnInsert),
    };
    const raw = {
      ...common,
      findOne: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn(async (identity, update) => {
        rawDocument = { ...identity, ...update.$setOnInsert };
        return { upsertedCount: 1 };
      }),
      find: jest.fn(() => ({
        ...emptyCursor(),
        limit() { return { toArray: async () => [rawDocument] }; },
      })),
    };
    const metrics = { ...common, updateOne: jest.fn().mockResolvedValue({}) };
    const collections = { price_events: raw, alert_decisions: decisions, metrics, alerts: common };
    const db = { databaseName: "test_database", collection: (name) => collections[name] };
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collector = createOperationTimings();
      const { callback, config } = await captureAnalyticsCallback(db, "test-topic", "127.0.0.1:9092", collector);
      expect(config.processingTimings).toBe(true);
      const measurements = createMeasurements("test-topic", 0, 1, undefined, collector);
      measurements.startMeasured();
      await measurements.process({
        topic: "test-topic", partition: 0,
        message: { offset: "0", value: Buffer.from(payload(0)) },
      }, callback);
      const result = collector.summarize(measurements.verify().samples);
      expect(decisions.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(raw.updateOne).toHaveBeenCalledTimes(1);
      expect(metrics.updateOne).toHaveBeenCalledTimes(1);
      expect(rawDocument._id).toBe(JSON.stringify(["test-topic", 0, "0"]));
      expect(result.samples[0]).toMatchObject({
        topic: "test-topic", partition: 0, offset: "0", classification: "new",
      });
      expect(result.operations.decisionPersistence.count).toBe(1);
      expect(result.operations.retentionQuery.count).toBe(1);
      expect(result.operations.alertPersistence.count).toBe(0);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("analytics benchmark operation timings", () => {
  test("implements the production interface, excludes warm-up, and attributes raw intervals", async () => {
    let time = 0;
    const now = () => time;
    const collector = createOperationTimings(now);
    const measurements = createMeasurements("test-topic", 1, 2, now, collector);
    const callback = async ({ message }) => {
      const timing = collector.beginEvent();
      time += 1;
      timing.start("decisionPersistence");
      time += message.offset === "1" ? 2 : 4;
      timing.end();
      timing.start("rawPersistence");
      timing.classify("new");
      time += 2;
      timing.end();
      time += 1;
      timing.finish(true);
      time += 1;
    };
    await measurements.process(record(0), callback);
    measurements.startMeasured();
    await measurements.process(record(1), callback);
    await measurements.process(record(2), callback);
    const processing = measurements.verify();
    const result = collector.summarize(processing.samples);
    expect(result.samples.map(({ topic, partition, offset }) => ({ topic, partition, offset }))).toEqual([
      { topic: "test-topic", partition: 0, offset: "1" },
      { topic: "test-topic", partition: 0, offset: "2" },
    ]);
    expect(result.samples[0].operations).toEqual([
      expect.objectContaining({ name: "decisionPersistence", durationMs: 2 }),
      expect.objectContaining({ name: "rawPersistence", durationMs: 2 }),
    ]);
    expect(result.operations.decisionPersistence).toEqual({ count: 2, totalMs: 6, p50Ms: 2, p95Ms: 4 });
    expect(result.operations.rawPersistence).toEqual({ count: 2, totalMs: 4, p50Ms: 2, p95Ms: 2 });
    expect(result.operations.retentionDeletion).toEqual({ count: 0, totalMs: 0, p50Ms: null, p95Ms: null });
    expect(result.successfulEvent).toEqual({ count: 2, totalMs: 14, p50Ms: 6, p95Ms: 8 });
    expect(result.uncoveredCallback).toEqual({ count: 2, totalMs: 6, p50Ms: 3, p95Ms: 3 });
    expect(result.samples.map((sample) => sample.callback.durationMs)).toEqual([7, 9]);
    expect(processing.observedBackloggedCallbacksPerSecond).toBeCloseTo(2000 / 16);
  });

  test("uses the union of overlapping and nested intervals", () => {
    const intervals = [
      { startedMs: 7, finishedMs: 10 },
      { startedMs: 3, finishedMs: 4 },
      { startedMs: 2, finishedMs: 8 },
      { startedMs: 12, finishedMs: 14 },
    ];
    expect(intervalUnionDuration(intervals, 0, 20)).toBe(10);
    expect(20 - intervalUnionDuration(intervals, 0, 20)).toBe(10);
    expect(intervalUnionDuration([], 0, 20)).toBe(0);
    expect(() => intervalUnionDuration([{ startedMs: 5, finishedMs: 4 }], 0, 20)).toThrow();
    expect(() => intervalUnionDuration([{ startedMs: -1, finishedMs: 4 }], 0, 20)).toThrow();
    expect(() => intervalUnionDuration([{ startedMs: 1, finishedMs: 21 }], 0, 20)).toThrow();
    expect(() => intervalUnionDuration([{ startedMs: NaN, finishedMs: 4 }], 0, 20)).toThrow();
  });

  test("rejects mismatched timing boundaries and an invalid clock", () => {
    let time = 1;
    const collector = createOperationTimings(() => time);
    expect(() => collector.beginEvent()).toThrow("boundary");
    collector.beginCallback(record(0), 0, true);
    const event = collector.beginEvent();
    expect(() => collector.beginEvent()).toThrow("boundary");
    expect(() => event.end()).toThrow("without a start");
    event.start("rawPersistence");
    expect(() => event.start("decisionPersistence")).toThrow("overlapping");
    time = 0;
    expect(() => event.end()).toThrow("boundaries");
    collector.abortCallback();
    expect(() => event.finish(true)).toThrow("not active");
  });

  test("rejects unexpected concurrent callbacks without misattributing the first", async () => {
    let time = 0;
    const now = () => time++;
    const collector = createOperationTimings(now);
    const measurements = createMeasurements("test-topic", 0, 2, now, collector);
    measurements.startMeasured();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const first = measurements.process(record(0), async () => {
      const timing = collector.beginEvent();
      timing.start("rawPersistence");
      await pending;
      timing.end();
      timing.finish(true);
    });
    await expect(measurements.process(record(1), jest.fn())).rejects.toThrow("Overlapping");
    release();
    await first;
    expect(collector.summarize([{ offset: "0", startedMs: 0, finishedMs: 6 }]).samples[0].offset).toBe("0");
    expect(() => measurements.verify()).toThrow("counts");
  });

  test("does not report failed or untimed callbacks as successful", async () => {
    let time = 0;
    const now = () => time++;
    const collector = createOperationTimings(now);
    const measurements = createMeasurements("test-topic", 0, 3, now, collector);
    measurements.startMeasured();
    const failure = new Error("database failure");
    await expect(measurements.process(record(0), async () => {
      const timing = collector.beginEvent();
      timing.start("decisionPersistence");
      timing.finish(false);
      throw failure;
    })).rejects.toBe(failure);
    await expect(measurements.process(record(1), async () => {}))
      .rejects.toThrow("without a successful timing event");
    await expect(measurements.process(record(2), async () => {
      collector.beginEvent().finish(true);
      throw failure;
    })).rejects.toBe(failure);
    expect(collector.summarize([]).successfulEvent.count).toBe(0);
    expect(() => measurements.verify()).toThrow("counts");
  });
});

describe("analytics benchmark measurements", () => {
  test("excludes warm-up and measures callback entry through successful return", async () => {
    const times = [1, 2, 10, 12, 30, 34];
    const measurements = createMeasurements("test-topic", 1, 2, () => times.shift());
    const callback = jest.fn().mockResolvedValue();
    await measurements.process(record(0), callback);
    measurements.startMeasured();
    await measurements.process(record(1), callback);
    await measurements.process(record(2), callback);
    const result = measurements.verify();
    expect(result.samples.map((item) => item.offset)).toEqual(["1", "2"]);
    expect(result.samples.map((item) => item.latencyMs)).toEqual([2, 4]);
    expect(result.firstCallbackStartedMs).toBe(10);
    expect(result.lastCallbackFinishedMs).toBe(34);
    expect(result.observedBackloggedCallbacksPerSecond).toBeCloseTo(2000 / 24);
    expect(result.p50Ms).toBe(2);
    expect(result.p95Ms).toBe(4);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  test("calculates nearest-rank p50 and p95 without mutating samples", () => {
    const samples = [4, 1, 3, 2, 5];
    expect(percentile(samples, 0.5)).toBe(3);
    expect(percentile(samples, 0.95)).toBe(5);
    expect(samples).toEqual([4, 1, 3, 2, 5]);
    expect(() => percentile([], 0.5)).toThrow();
  });

  test("rejects missing, duplicate, unexpected, and failed callback records", async () => {
    const measurements = createMeasurements("test-topic", 1, 2);
    const callback = jest.fn().mockResolvedValue();
    await measurements.process(record(0), callback);
    await expect(measurements.process(record(0), callback)).rejects.toThrow("duplicate");
    measurements.startMeasured();
    await expect(measurements.process(record(3), callback)).rejects.toThrow("Unexpected");
    expect(() => measurements.verify()).toThrow("counts");
    const failed = createMeasurements("test-topic", 0, 1);
    failed.startMeasured();
    const error = new Error("processing failed");
    await expect(failed.process(record(0), jest.fn().mockRejectedValue(error))).rejects.toBe(error);
    expect(() => failed.verify()).toThrow("unsuccessful");
  });

  test("verifies exact persisted identities and rejects duplicates", () => {
    const expected = ["id-0", "id-1"];
    expect(() => verifyIdentities([{ _id: "id-1" }, { _id: "id-0" }], expected, "Raw")).not.toThrow();
    expect(() => verifyIdentities([{ _id: "id-0" }, { _id: "id-0" }], expected, "Raw")).toThrow();
    expect(() => verifyIdentities([{ _id: "id-0" }], expected, "Raw")).toThrow();
    expect(() => verifyIdentities([{ _id: "id-0" }, { _id: "id-2" }], expected, "Raw")).toThrow();
  });

  test("separates producer time from restart-to-callback and restart-to-commit", () => {
    expect(summarizeSendAndCommit(100, 300, 350, 800, 900, 1000)).toEqual({
      sendDurationMs: 200,
      acknowledgedPerSecond: 5000,
      restartToLastCallbackMs: 450,
      restartToCommitObservedMs: 550,
    });
    expect(() => summarizeSendAndCommit(100, 300, 299, 800, 900, 1000)).toThrow();
    expect(() => summarizeSendAndCommit(100, 300, 350, 800, 799, 1000)).toThrow();
  });

  test("requires successful warm-up before releasing measured callbacks", async () => {
    const measurements = createMeasurements("test-topic", 1, 1);
    const callback = jest.fn().mockResolvedValue();
    expect(() => measurements.startMeasured()).toThrow("warm-up");
    await expect(measurements.process(record(1), callback)).rejects.toThrow("before the verified backlog");
    expect(callback).not.toHaveBeenCalled();
    await measurements.process(record(0), callback);
    measurements.startMeasured();
    await measurements.process(record(1), callback);
    expect(() => measurements.startMeasured()).toThrow();
  });

  test("requires a stopped group and exactly the acknowledged backlog", () => {
    const offsets = [{ partition: 0, low: "0", high: "1100" }];
    const group = { groups: [{ groupId: "test-group", state: "Empty", members: [] }] };
    const check = (entries, committed, description, callbacks) =>
      verifyBacklog(entries, committed, description, "test-topic", "test-group", callbacks, 100, 1000);
    expect(check(offsets, "100", group, 100)).toEqual({
      committedOffset: "100", endOffset: "1100", queuedRecords: 1000,
    });
    expect(() => check(offsets, "101", group, 100)).toThrow("backlog");
    expect(() => check([{ ...offsets[0], high: "1099" }], "100", group, 100)).toThrow("backlog");
    expect(() => check(offsets, "100", group, 101)).toThrow("backlog");
    expect(() => check(offsets, "100", {
      groups: [{ groupId: "test-group", state: "Stable", members: [{}] }],
    }, 100)).toThrow("backlog");
  });

  test("readiness accepts an empty fetch after assignment and resets on rebalance", () => {
    const consumer = new EventEmitter();
    consumer.events = { GROUP_JOIN: "join", FETCH: "fetch", REBALANCING: "rebalance" };
    const ready = trackConsumerReadiness(consumer, "test-topic");
    consumer.emit("fetch", { payload: { numberOfBatches: 0 } });
    expect(ready()).toBe(false);
    consumer.emit("join", { payload: { memberAssignment: { "test-topic": [0] } } });
    expect(ready()).toBe(false);
    consumer.emit("fetch", { payload: { numberOfBatches: 0 } });
    expect(ready()).toBe(true);
    consumer.emit("rebalance");
    expect(ready()).toBe(false);
  });

  test("uses deterministic ticker payloads", () => {
    expect(payload(17)).toBe(payload(17));
    expect(JSON.parse(payload(17))).toMatchObject({ symbol: "BTC-USD", price: expect.any(Number) });
  });
});
