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
  let eachMessage;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockConsumer.connect.mockResolvedValue();
    mockConsumer.subscribe.mockResolvedValue();
    mockConsumer.run.mockResolvedValue();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    await startConsumer();
    eachMessage = mockConsumer.run.mock.calls[0][0].eachMessage;
  });

  afterEach(() => {
    errorSpy.mockRestore();
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

  it("completes successfully after event persistence and metric update", async () => {
    const { priceEventsCollection, metricsCollection } = configureDatabase();
    const event = {
      symbol: "TEST-USD",
      price: 100,
      timestamp: "2026-04-04T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).resolves.toBeUndefined();

    expect(priceEventsCollection.insertOne).toHaveBeenCalledWith(
      expect.objectContaining(event)
    );
    expect(metricsCollection.updateOne).toHaveBeenCalledWith(
      { symbol: event.symbol },
      expect.objectContaining({ $set: expect.objectContaining({ latestPrice: 100 }) }),
      { upsert: true }
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs and discards malformed JSON without processing it", async () => {
    getDB.mockClear();

    await expect(eachMessage(kafkaMessage("{invalid json"))).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      "Discarding malformed Kafka message:",
      expect.any(String)
    );
    expect(getDB).not.toHaveBeenCalled();
  });

  it("rejects the callback when MongoDB persistence fails", async () => {
    const persistenceError = new Error("MongoDB write failed");
    configureDatabase({
      insertOne: jest.fn().mockRejectedValue(persistenceError),
    });
    const event = {
      symbol: "TEST-USD",
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
      symbol: "TEST-USD",
      price: 100,
      timestamp: "2026-04-04T12:00:00.000Z",
    };

    await expect(eachMessage(kafkaMessage(JSON.stringify(event)))).rejects.toBe(
      processingError
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
