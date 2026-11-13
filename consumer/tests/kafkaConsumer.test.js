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

const { getDB } = require("../src/mongoClient");
const { startConsumer } = require("../src/kafkaConsumer");

describe("Kafka consumer message handling", () => {
  let errorSpy;
  let warnSpy;
  let eachMessage;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConsumer.connect.mockResolvedValue();
    mockConsumer.subscribe.mockResolvedValue();
    mockConsumer.run.mockResolvedValue();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function configureDatabase({ insertOne = jest.fn().mockResolvedValue({}), updateOne } = {}) {
    const recentEventsCursor = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn().mockResolvedValue([{ price: 100 }]),
    };
    const priceEventsCollection = {
      insertOne,
      countDocuments: jest.fn().mockResolvedValue(1),
      find: jest.fn(() => recentEventsCursor),
    };
    const metricsCollection = {
      updateOne: updateOne || jest.fn().mockResolvedValue({}),
    };

    getDB.mockReturnValue({
      collection: jest.fn((name) => {
        if (name === "price_events") return priceEventsCollection;
        if (name === "metrics") return metricsCollection;
        return { insertOne: jest.fn().mockResolvedValue({}) };
      }),
    });

    return { priceEventsCollection, metricsCollection };
  }

  function kafkaMessage(value) {
    return { message: { value: Buffer.from(value) } };
  }

  it.each(["BTC-USD", "ETH-USD", "SOL-USD"])(
    "processes a valid %s event after persistence and metric update",
    async (symbol) => {
      const { priceEventsCollection, metricsCollection } = configureDatabase();
      const event = {
        symbol,
        price: 100,
        timestamp: "2026-04-04T12:00:00.000Z",
      };

      await expect(
        eachMessage(kafkaMessage(JSON.stringify(event)))
      ).resolves.toBeUndefined();

      expect(priceEventsCollection.insertOne).toHaveBeenCalledWith(
        expect.objectContaining(event)
      );
      expect(metricsCollection.updateOne).toHaveBeenCalledWith(
        { symbol: event.symbol },
        expect.objectContaining({
          $set: expect.objectContaining({ latestPrice: 100 }),
        }),
        { upsert: true }
      );
      expect(errorSpy).not.toHaveBeenCalled();
    }
  );

  it("logs and discards malformed JSON without processing it", async () => {
    getDB.mockClear();

    await expect(eachMessage(kafkaMessage("{invalid json"))).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "Discarding malformed Kafka event JSON:",
      expect.any(String)
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it.each([
    ["null event", "null"],
    [
      "missing symbol",
      JSON.stringify({ price: 1, timestamp: "2026-04-04T12:00:00Z" }),
    ],
    [
      "unsupported symbol",
      JSON.stringify({
        symbol: "DOGE-USD",
        price: 1,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "missing price",
      JSON.stringify({ symbol: "BTC-USD", timestamp: "2026-04-04T12:00:00Z" }),
    ],
    [
      "null price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: null,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "empty price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "whitespace price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "   ",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "nonnumeric price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "nope",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "NaN price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: "NaN",
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "non-finite price",
      '{"symbol":"BTC-USD","price":1e1000,"timestamp":"2026-04-04T12:00:00Z"}',
    ],
    [
      "zero price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: 0,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "negative price",
      JSON.stringify({
        symbol: "BTC-USD",
        price: -1,
        timestamp: "2026-04-04T12:00:00Z",
      }),
    ],
    [
      "missing timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1 }),
    ],
    [
      "null timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1, timestamp: null }),
    ],
    [
      "empty timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1, timestamp: "" }),
    ],
    [
      "invalid timestamp",
      JSON.stringify({ symbol: "BTC-USD", price: 1, timestamp: "invalid" }),
    ],
  ])("discards %s before database access", async (_description, value) => {
    getDB.mockClear();

    await expect(eachMessage(kafkaMessage(value))).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      "Discarding invalid Kafka event:",
      expect.any(String)
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it("discards an event without a Kafka value", async () => {
    getDB.mockClear();

    await expect(eachMessage({ message: { value: null } })).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "Discarding invalid Kafka event: message value is missing"
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it("rejects the callback when MongoDB persistence fails", async () => {
    const persistenceError = new Error("MongoDB write failed");
    configureDatabase({
      insertOne: jest.fn().mockRejectedValue(persistenceError),
    });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2026-04-04T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).rejects.toBe(
      persistenceError
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("propagates unexpected processing errors instead of treating them as success", async () => {
    const processingError = new Error("Unexpected database access error");
    getDB.mockImplementation(() => {
      throw processingError;
    });
    const event = {
      symbol: "BTC-USD",
      price: 100,
      timestamp: "2026-04-04T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).rejects.toBe(
      processingError
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
