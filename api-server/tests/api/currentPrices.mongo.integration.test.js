const { randomUUID } = require("node:crypto");
const { MongoClient, Long } = require("mongodb");
const request = require("supertest");
const app = require("../../src/app");
const { getDB } = require("../../src/db");

jest.mock("../../src/db", () => ({ getDB: jest.fn() }));

const uri = process.env.MONGO_INTEGRATION_URI;
const describeMongo = uri ? describe : describe.skip;

describeMongo("current-price API with isolated MongoDB", () => {
  const dbName = `current_price_api_test_${randomUUID().replace(/-/g, "")}`;
  let client, db, current, metrics;
  const snapshot = {
    _id: "BTC-USD", symbol: "BTC-USD", price: 68000.25,
    marketTimestamp: "2026-04-04T12:00:00.123456789Z",
    marketTimeKey: "2026-04-04T12:00:00.123456789Z",
    receivedAt: new Date("2026-04-04T12:00:01.234Z"),
    kafkaTopic: "test-topic", kafkaPartition: 0, kafkaOffset: Long.fromString("9007199254740993"),
  };

  beforeAll(async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    current = db.collection("current_prices");
    metrics = db.collection("metrics");
    getDB.mockReturnValue(db);
  });
  afterAll(async () => {
    try { if (db) await db.dropDatabase(); } finally { if (client) await client.close(); }
  });
  beforeEach(async () => {
    await current.deleteMany({});
    await metrics.deleteMany({});
  });

  it("returns real snapshots without internal fields and makes no changes", async () => {
    await current.insertMany([
      snapshot,
      { ...snapshot, _id: "DOGE-USD", symbol: "DOGE-USD" },
    ]);
    await metrics.insertOne({ symbol: "BTC-USD", latestPrice: 42, updatedAt: "2020-01-01T00:00:00Z" });
    const before = await current.find({}).sort({ _id: 1 }).toArray();
    const response = await request(app).get("/api/prices/current");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true, count: 1,
      data: [{
        symbol: "BTC-USD", price: 68000.25,
        marketTimestamp: "2026-04-04T12:00:00.123456789Z",
        receivedAt: "2026-04-04T12:00:01.234Z",
      }],
    });
    expect(await current.find({}).sort({ _id: 1 }).toArray()).toEqual(before);
    const latest = await request(app).get("/api/prices/latest");
    const historicalMetrics = await request(app).get("/api/metrics");
    expect(latest.body.data).toEqual([{ symbol: "BTC-USD", latestPrice: 42, updatedAt: "2020-01-01T00:00:00Z" }]);
    expect(historicalMetrics.body.data).toEqual([{ symbol: "BTC-USD", latestPrice: 42, updatedAt: "2020-01-01T00:00:00Z" }]);
  });

  it("returns empty data instead of historical prices when no snapshot exists", async () => {
    await metrics.insertOne({ symbol: "BTC-USD", latestPrice: 42 });
    const response = await request(app).get("/api/prices/current");
    expect(response.body).toEqual({ success: true, count: 0, data: [] });
  });

  it("rejects an incomplete supported snapshot without changing it", async () => {
    await current.insertOne({ _id: "ETH-USD", price: 100 });
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request(app).get("/api/prices/current");
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ success: false, message: "Failed to fetch current prices" });
      expect(await current.findOne({ _id: "ETH-USD" })).toEqual({ _id: "ETH-USD", price: 100 });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
