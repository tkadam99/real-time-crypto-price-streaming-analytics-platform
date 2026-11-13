const mockConsumer = {
  connect: jest.fn(),
  subscribe: jest.fn(),
  run: jest.fn(),
};

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => ({ consumer: jest.fn(() => mockConsumer) })),
}));
jest.mock("../src/mongoClient", () => ({ getDB: jest.fn() }));
jest.mock("../src/analytics", () => {
  const actual = jest.requireActual("../src/analytics");
  return { ...actual, createLivePriceTracker: jest.fn(actual.createLivePriceTracker) };
});

describe("price baseline restoration at startup", () => {
  let groups;
  let histories;
  let priceAggregate;
  let startConsumer;
  let tracker;
  let warnSpy;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    groups = [];
    histories = {};
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockConsumer.connect.mockResolvedValue();
    mockConsumer.subscribe.mockResolvedValue();
    mockConsumer.run.mockResolvedValue();
    priceAggregate = jest.fn((pipeline) => ({
      toArray: jest.fn(async () => {
        const symbol = pipeline[0].$match.symbol;
        return typeof symbol === "string" ? histories[symbol] || [] : groups;
      }),
    }));
    const metrics = {
      aggregate: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([]) })),
      createIndex: jest.fn().mockResolvedValue("index"),
    };
    const alerts = {
      aggregate: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue([{
          _id: "BTC-USD",
          timestamp: new Date("2040-01-01T12:00:00Z"),
          eventId: "alert",
          invalidCount: 0,
        }]),
      })),
    };
    const prices = { aggregate: priceAggregate };
    require("../src/mongoClient").getDB.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === "metrics") return metrics;
        if (name === "alerts") return alerts;
        return prices;
      }),
    });
    const analytics = require("../src/analytics");
    ({ startConsumer } = require("../src/kafkaConsumer"));
    tracker = analytics.createLivePriceTracker.mock.results[0].value;
  });

  afterEach(() => warnSpy.mockRestore());

  it("starts without history and reports missing baselines", async () => {
    await startConsumer();

    expect(tracker.getBaseline("BTC-USD", "2040-01-01T12:01:00Z")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No persisted price history for BTC-USD")
    );
    expect(mockConsumer.run).toHaveBeenCalled();
  });

  it("restores ordered histories for multiple symbols without changing cooldowns", async () => {
    groups = [
      { _id: "BTC-USD", latest: new Date("2040-01-01T12:01:00Z"), invalidCount: 0 },
      { _id: "ETH-USD", latest: new Date("2040-01-01T12:01:00Z"), invalidCount: 0 },
    ];
    histories = {
      "BTC-USD": [
        { _id: "first", symbol: "BTC-USD", price: 100, timestamp: "2040-01-01T12:00:00Z" },
        { _id: "first", symbol: "BTC-USD", price: 500, timestamp: "2040-01-01T12:00:10Z" },
        { _id: "second", symbol: "BTC-USD", price: 101, timestamp: "2040-01-01T12:00:00Z" },
        { _id: "future", symbol: "BTC-USD", price: 999, timestamp: "2040-01-01T12:01:00Z" },
      ],
      "ETH-USD": [
        { _id: "eth", symbol: "ETH-USD", price: 200, timestamp: "2040-01-01T12:00:00Z" },
      ],
    };
    const recordPrice = jest.spyOn(tracker, "recordPrice");

    await startConsumer();

    expect(tracker.getBaseline("BTC-USD", "2040-01-01T12:01:00Z")).toMatchObject({
      price: 101,
      eventId: "second",
    });
    expect(tracker.getBaseline("ETH-USD", "2040-01-01T12:01:00Z").price).toBe(200);
    expect(tracker.getBaseline("BTC-USD", "2040-01-01T12:01:10Z").price).toBe(101);
    expect(tracker.isOnCooldown("BTC-USD", "2040-01-01T12:01:00Z")).toBe(true);
    expect(recordPrice).toHaveBeenCalledTimes(5);
    expect(priceAggregate.mock.calls[1][0]).toEqual(expect.arrayContaining([
      { $match: { eventTime: {
        $gte: new Date("2040-01-01T11:59:50Z"),
        $lte: new Date("2040-01-01T12:01:00Z"),
      } } },
      { $sort: { eventTime: 1, receivedAt: 1, _id: 1 } },
    ]));
  });

  it("reports when the latest event has no eligible baseline", async () => {
    groups = [{
      _id: "BTC-USD",
      latest: new Date("2040-01-01T12:01:00Z"),
      invalidCount: 0,
    }];
    histories = {
      "BTC-USD": [{
        _id: "one",
        symbol: "BTC-USD",
        price: 100,
        timestamp: "2040-01-01T12:01:00Z",
      }],
    };

    await startConsumer();

    expect(tracker.getBaseline("BTC-USD", "2040-01-01T12:01:00Z")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no eligible baseline for its latest event")
    );
  });

  it("does not start consuming if history loading fails", async () => {
    const failure = new Error("price history unavailable");
    priceAggregate.mockReturnValue({
      toArray: jest.fn().mockRejectedValue(failure),
    });

    await expect(startConsumer()).rejects.toBe(failure);
    expect(mockConsumer.connect).not.toHaveBeenCalled();
    expect(mockConsumer.run).not.toHaveBeenCalled();
  });

  it("does not start consuming if the bounded history query fails", async () => {
    groups = [{
      _id: "BTC-USD",
      latest: new Date("2040-01-01T12:01:00Z"),
      invalidCount: 0,
    }];
    const failure = new Error("bounded price history unavailable");
    const firstQuery = priceAggregate.getMockImplementation();
    priceAggregate.mockImplementation((pipeline) => {
      if (typeof pipeline[0].$match.symbol === "string") {
        return { toArray: jest.fn().mockRejectedValue(failure) };
      }
      return firstQuery(pipeline);
    });

    await expect(startConsumer()).rejects.toBe(failure);
    expect(mockConsumer.connect).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted history before consuming", async () => {
    groups = [{
      _id: "BTC-USD",
      latest: new Date("2040-01-01T12:01:00Z"),
      invalidCount: 0,
    }];
    histories = {
      "BTC-USD": [{
        _id: "bad",
        symbol: "BTC-USD",
        price: 0,
        timestamp: "2040-01-01T12:01:00Z",
      }],
    };

    await expect(startConsumer()).rejects.toThrow("price must be a finite positive number");
    expect(mockConsumer.connect).not.toHaveBeenCalled();
  });

  it("rejects invalid persisted timestamps before consuming", async () => {
    groups = [{ _id: "BTC-USD", latest: null, invalidCount: 1 }];

    await expect(startConsumer()).rejects.toThrow(
      "Cannot restore price baseline for BTC-USD: persisted event timestamp is invalid."
    );
    expect(mockConsumer.connect).not.toHaveBeenCalled();
  });
});
