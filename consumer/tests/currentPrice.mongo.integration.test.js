const { randomUUID } = require("node:crypto");
const { MongoClient } = require("mongodb");
const { parseEvent, createCurrentPriceProjection } = require("../src/currentPriceProjection");

const uri = process.env.MONGO_INTEGRATION_URI;
const describeMongo = uri ? describe : describe.skip;

describeMongo("current price MongoDB projection", () => {
  const dbName = `current_price_test_${randomUUID().replace(/-/g, "")}`;
  let client, db, collection, store;
  const now = Date.parse("2026-01-01T00:01:00Z");
  function snapshot(timestamp, partition, offset, price, topic = "topic") {
    return parseEvent({
      topic, partition,
      message: { offset: String(offset), value: Buffer.from(JSON.stringify({ symbol: "BTC-USD", price, timestamp })) },
    }, ["BTC-USD"], now).snapshot;
  }
  beforeAll(async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    collection = db.collection("current_prices");
    store = createCurrentPriceProjection(collection);
  });
  afterAll(async () => {
    try { if (db) await db.dropDatabase(); } finally { if (client) await client.close(); }
  });
  beforeEach(async () => { await collection.deleteMany({}); });

  test("newer nanosecond time wins, older and duplicate deliveries do not change it", async () => {
    const newer = snapshot("2026-01-01T00:00:00.000000002Z", 0, 10, 102);
    const older = snapshot("2026-01-01T00:00:00.000000001Z", 0, 11, 99);
    await store.save(newer);
    await store.save(older);
    await store.save({ ...newer, price: 999, receivedAt: new Date(now + 1000) });
    const result = await collection.findOne({ _id: "BTC-USD" });
    expect(result).toMatchObject({ price: 102, marketTimeKey: newer.marketTimeKey, receivedAt: new Date(now) });
    expect(await collection.countDocuments()).toBe(1);
  });

  test("ties use topic, partition, then exact numeric offset", async () => {
    const ts = "2026-01-01T00:00:00.123456789Z";
    await Promise.all([
      store.save(snapshot(ts, 0, "9007199254740993", 1, "a")),
      store.save(snapshot(ts, 0, "9007199254740994", 2, "a")),
      store.save(snapshot(ts, 1, "1", 3, "a")),
      store.save(snapshot(ts, 0, "0", 4, "b")),
    ]);
    expect(await collection.findOne({ _id: "BTC-USD" })).toMatchObject({ price: 4, kafkaTopic: "b" });
    expect(await collection.countDocuments()).toBe(1);
    await collection.deleteMany({});
    await Promise.all([
      store.save(snapshot(ts, 1, "9007199254740993", 1)),
      store.save(snapshot(ts, 1, "9007199254740994", 2)),
    ]);
    expect(await collection.findOne({ _id: "BTC-USD" })).toMatchObject({ price: 2 });
  });

  test("concurrent first upserts leave exactly one latest snapshot and the default unique _id index", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, index) =>
      store.save(snapshot(`2026-01-01T00:00:00.${String(index).padStart(9, "0")}Z`, 0, index, index + 1))
    ));
    expect(await collection.countDocuments()).toBe(1);
    expect(await collection.findOne({ _id: "BTC-USD" })).toMatchObject({ price: 30 });
    expect((await collection.indexes()).find((index) => index.name === "_id_")).toBeDefined();
  });
});
