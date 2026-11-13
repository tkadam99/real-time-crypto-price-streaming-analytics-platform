const mockConsumer = {
  connect: jest.fn(),
  subscribe: jest.fn(),
  run: jest.fn(),
};

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => ({
    consumer: jest.fn(() => mockConsumer),
  })),
}));

jest.mock("../src/mongoClient", () => ({
  getDB: jest.fn(),
}));

jest.mock("../src/analytics", () => {
  const actual = jest.requireActual("../src/analytics");
  return {
    ...actual,
    createLivePriceTracker: jest.fn(actual.createLivePriceTracker),
  };
});

describe("alert cooldown restoration at startup", () => {
  let latestAlerts;
  let alertsAggregate;
  let startConsumer;
  let tracker;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    latestAlerts = [];
    mockConsumer.connect.mockResolvedValue();
    mockConsumer.subscribe.mockResolvedValue();
    mockConsumer.run.mockResolvedValue();

    alertsAggregate = jest.fn(() => ({
      toArray: jest.fn(async () => latestAlerts),
    }));
    const metrics = {
      aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
      createIndex: jest.fn().mockResolvedValue("unique_metrics_symbol"),
    };
    const alerts = { aggregate: alertsAggregate };
    const priceEvents = {
      aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
    };
    require("../src/mongoClient").getDB.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === "metrics") return metrics;
        if (name === "alerts") return alerts;
        return priceEvents;
      }),
    });

    const analytics = require("../src/analytics");
    ({ startConsumer } = require("../src/kafkaConsumer"));
    tracker = analytics.createLivePriceTracker.mock.results[0].value;
  });

  it("starts with empty cooldown state when no alerts are persisted", async () => {
    await startConsumer();

    expect(alertsAggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        { $match: { symbol: { $in: ["BTC-USD", "ETH-USD", "SOL-USD"] } } },
      ])
    );
    expect(tracker.isOnCooldown("BTC-USD", "2040-01-01T12:09:00.000Z")).toBe(false);
    expect(mockConsumer.run).toHaveBeenCalledTimes(1);
  });

  it("restores one symbol using event time, including millisecond precision", async () => {
    latestAlerts = [{
      _id: "BTC-USD",
      timestamp: new Date("2040-01-01T12:08:00.500Z"),
      eventId: "btc-record",
      invalidCount: 0,
    }];

    await startConsumer();

    expect(tracker.isOnCooldown("BTC-USD", "2040-01-01T12:13:00.499Z")).toBe(true);
    expect(tracker.isOnCooldown("BTC-USD", "2040-01-01T12:13:00.500Z")).toBe(false);
    expect(tracker.isOnCooldown("ETH-USD", "2040-01-01T12:09:00.000Z")).toBe(false);
  });

  it("restores multiple symbols independently and does not rewind on older replay", async () => {
    latestAlerts = [
      { _id: "BTC-USD", timestamp: new Date("2040-01-01T12:08:00Z"), eventId: "btc", invalidCount: 0 },
      { _id: "ETH-USD", timestamp: new Date("2040-01-01T12:03:00Z"), eventId: "eth", invalidCount: 0 },
    ];

    await startConsumer();
    tracker.recordAlert("BTC-USD", "2040-01-01T12:02:00Z", "older");

    expect(tracker.isOnCooldown("BTC-USD", "2040-01-01T12:09:00Z")).toBe(true);
    expect(tracker.isOnCooldown("ETH-USD", "2040-01-01T12:09:00Z")).toBe(false);
    expect(tracker.isOnCooldown("SOL-USD", "2040-01-01T12:09:00Z")).toBe(false);
  });

  it("does not connect to Kafka if loading alert state fails", async () => {
    const failure = new Error("alert database unavailable");
    alertsAggregate.mockReturnValue({
      toArray: jest.fn().mockRejectedValue(failure),
    });

    await expect(startConsumer()).rejects.toBe(failure);
    expect(mockConsumer.connect).not.toHaveBeenCalled();
    expect(mockConsumer.subscribe).not.toHaveBeenCalled();
    expect(mockConsumer.run).not.toHaveBeenCalled();
  });

  it("does not connect to Kafka if a persisted alert timestamp is invalid", async () => {
    latestAlerts = [{
      _id: "BTC-USD",
      timestamp: null,
      eventId: "invalid",
      invalidCount: 1,
    }];

    await expect(startConsumer()).rejects.toThrow(
      "Cannot restore alert cooldown for BTC-USD: persisted alert timestamp is invalid."
    );
    expect(mockConsumer.connect).not.toHaveBeenCalled();
    expect(mockConsumer.run).not.toHaveBeenCalled();
  });
});
