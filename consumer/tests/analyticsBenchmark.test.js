const {
  captureAnalyticsCallback,
  createMeasurements,
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
      const { callback } = await captureAnalyticsCallback(db, "test-topic", "127.0.0.1:9092");
      await callback({
        topic: "test-topic", partition: 0,
        message: { offset: "0", value: Buffer.from(payload(0)) },
      });
      expect(decisions.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(raw.updateOne).toHaveBeenCalledTimes(1);
      expect(metrics.updateOne).toHaveBeenCalledTimes(1);
      expect(rawDocument._id).toBe(JSON.stringify(["test-topic", 0, "0"]));
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
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
