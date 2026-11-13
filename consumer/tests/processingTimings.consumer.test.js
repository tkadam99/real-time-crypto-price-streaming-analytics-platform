const mockConsumer = {
  connect: jest.fn(),
  subscribe: jest.fn(),
  run: jest.fn(),
};

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => ({ consumer: () => mockConsumer })),
}));
jest.mock("../src/mongoClient", () => ({ getDB: jest.fn() }));

describe("consumer processing timings", () => {
  let log;
  let warn;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    mockConsumer.connect.mockReset().mockResolvedValue();
    mockConsumer.subscribe.mockReset().mockResolvedValue();
    mockConsumer.run.mockReset().mockResolvedValue();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.dontMock("../src/config");
    jest.useRealTimers();
    log.mockRestore();
    warn.mockRestore();
  });

  async function start(enabled) {
    jest.doMock("../src/config", () => ({
      ...jest.requireActual("../src/config"),
      processingTimings: enabled,
    }));

    let stored;
    const failure = new Error("metrics write failed");
    const raw = {
      aggregate: jest.fn(() => ({ toArray: async () => [] })),
      createIndex: jest.fn().mockResolvedValue("index"),
      updateOne: jest.fn(async (identity, update) => {
        if (stored) return { upsertedCount: 0 };
        stored = { _id: identity._id, ...update.$setOnInsert };
        return { upsertedCount: 1 };
      }),
      findOne: jest.fn(async (identity) => stored && stored._id === identity._id ? stored : null),
      find: jest.fn((filter) => {
        let retention = false;
        const cursor = {
          sort: () => cursor,
          limit: () => cursor,
          skip: () => { retention = true; return cursor; },
          project: () => cursor,
          toArray: async () => retention ? [{ _id: "old" }] :
            filter.timestamp ? [] : [stored],
        };
        return cursor;
      }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    const metrics = {
      aggregate: jest.fn(() => ({ toArray: async () => [] })),
      createIndex: jest.fn().mockResolvedValue("index"),
      updateOne: jest.fn().mockRejectedValueOnce(failure).mockResolvedValue({}),
    };
    const alerts = {
      aggregate: jest.fn(() => ({ toArray: async () => [] })),
      createIndex: jest.fn().mockResolvedValue("index"),
      updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }),
    };
    const documents = new Map();
    const decisions = {
      findOne: jest.fn(async ({ _id }) => documents.get(_id) || null),
      findOneAndUpdate: jest.fn(async ({ _id }, update) => {
        if (!documents.has(_id)) documents.set(_id, update.$setOnInsert);
        return documents.get(_id);
      }),
    };
    const collections = { price_events: raw, metrics, alerts, alert_decisions: decisions };
    require("../src/mongoClient").getDB.mockReturnValue({
      collection: (name) => collections[name],
    });
    await require("../src/kafkaConsumer").startConsumer();
    return { eachMessage: mockConsumer.run.mock.calls[0][0].eachMessage, failure, raw, metrics, alerts };
  }

  const record = {
    topic: "test",
    partition: 0,
    message: {
      offset: "1",
      value: Buffer.from(JSON.stringify({
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2026-01-01T00:00:00.000Z",
      })),
    },
  };

  it("does not schedule timing reports when disabled", async () => {
    await start(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("reports failed and replayed attempts without swallowing processing errors", async () => {
    const { eachMessage, failure, raw, metrics } = await start(true);
    await expect(eachMessage(record)).rejects.toBe(failure);
    await expect(eachMessage(record)).resolves.toBeUndefined();
    expect(raw.updateOne).toHaveBeenCalledTimes(2);
    expect(raw.findOne).toHaveBeenCalledTimes(2);
    expect(metrics.updateOne).toHaveBeenCalledTimes(2);
    expect(raw.deleteMany).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60_000);
    const entry = log.mock.calls.find(([message]) => message === "Consumer processing timings:");
    const summary = JSON.parse(entry[1]);
    expect(summary).toMatchObject({
      successfulEvents: 1,
      failedAttempts: 1,
      classifications: {
        new: {
          failedAttempts: 1,
          operations: {
            decisionPersistence: { count: 1 },
            rawPersistence: { count: 1 },
            recentHistory: { count: 1 },
            predecessor: { count: 1 },
            metricsCalculation: { count: 1 },
            metricsPersistence: { count: 1 },
            retentionQuery: { count: 0 },
          },
        },
        replay: {
          successfulEvents: 1,
          operations: {
            decisionPersistence: { count: 1 },
            rawPersistence: { count: 1 },
            recentHistory: { count: 1 },
            predecessor: { count: 1 },
            metricsCalculation: { count: 1 },
            metricsPersistence: { count: 1 },
            retentionQuery: { count: 1 },
            retentionDeletion: { count: 1 },
            alertPersistence: { count: 0 },
            successfulEvent: { count: 1 },
          },
        },
      },
    });
  });

  it("measures alert persistence only when an alert is created", async () => {
    const { eachMessage, raw, metrics, alerts } = await start(true);
    metrics.updateOne.mockReset().mockResolvedValue({});
    await eachMessage(record);
    raw.updateOne.mockResolvedValueOnce({ upsertedCount: 1 });
    await eachMessage({
      ...record,
      message: {
        offset: "2",
        value: Buffer.from(JSON.stringify({
          symbol: "BTC-USD",
          price: 110,
          timestamp: "2026-01-01T00:01:00.000Z",
        })),
      },
    });
    expect(alerts.updateOne).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    const entry = log.mock.calls.find(([message]) => message === "Consumer processing timings:");
    const group = JSON.parse(entry[1]).classifications.new;
    expect(group.successfulEvents).toBe(2);
    expect(group.operations.alertPersistence.count).toBe(1);
  });
});
