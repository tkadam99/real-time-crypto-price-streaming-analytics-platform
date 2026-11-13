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
    client = new MongoClient(integrationUri);
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
    for (const name of ["price_events", "metrics", "alerts"]) {
      await db.collection(name).deleteMany({});
    }

    jest.resetModules();
    mockConsumer.connect.mockReset().mockResolvedValue();
    mockConsumer.subscribe.mockReset().mockResolvedValue();
    mockConsumer.run.mockReset().mockResolvedValue();

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
      previousPrice: 100,
      movingAverage: 105,
      percentChange: 10,
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
