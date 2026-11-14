const { randomUUID } = require("node:crypto");
const { MongoClient } = require("mongodb");
const { algorithms, createIndexes, event, historyInputs, ordered, upsertEvent } = require("./retentionHarness");

const uri = process.env.MONGO_INTEGRATION_URI;
const describeMongo = uri ? describe : describe.skip;

describeMongo("isolated strict retention candidate comparison", () => {
  jest.setTimeout(120000);
  const dbName = `retention_harness_test_${randomUUID().replace(/-/g, "")}`;
  let client, db, collections;
  const target = 3;
  const names = Object.keys(algorithms);

  beforeAll(async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    collections = Object.fromEntries(names.map((name) => [name, db.collection(name)]));
    for (const collection of Object.values(collections)) await createIndexes(collection);
  });
  afterAll(async () => {
    try { if (db) await db.dropDatabase(); } finally { if (client) await client.close(); }
  });
  beforeEach(async () => {
    for (const collection of Object.values(collections)) await collection.deleteMany({});
  });

  async function seed(documents) {
    if (documents.length) {
      for (const collection of Object.values(collections)) await collection.insertMany(documents);
    }
  }
  async function compare() {
    const expected = await ordered(collections.reference);
    for (const name of names.slice(1)) {
      expect(await ordered(collections[name])).toEqual(expected);
      for (const symbol of ["BTC-USD", "ETH-USD"]) {
        expect(await historyInputs(collections[name], symbol)).toEqual(await historyInputs(collections.reference, symbol));
      }
    }
  }
  async function prune(symbol) {
    for (const name of names) await algorithms[name](collections[name], symbol, target);
    await compare();
  }

  test.each([0, 2, 3, 4, 25])("retains exact identities for %i initial records", async (count) => {
    await seed(Array.from({ length: count }, (_, index) => event("BTC-USD", index)));
    await prune("BTC-USD");
    const docs = await ordered(collections.reference);
    expect(docs.map((doc) => doc._id)).toEqual(
      Array.from({ length: Math.min(count, target) }, (_, index) =>
        event("BTC-USD", count - 1 - index)._id)
    );
  });

  test.each([0, 2, 3])("does not issue a deletion at or below target (%i records)", async (count) => {
    await seed(Array.from({ length: count }, (_, index) => event("BTC-USD", index)));
    for (const name of names) {
      const beforeDelete = jest.fn();
      await algorithms[name](collections[name], "BTC-USD", target, { beforeDelete });
      expect(beforeDelete).not.toHaveBeenCalled();
    }
    await compare();
  });

  test("late, out-of-order, tie, replay and reinserted events preserve order and symbol isolation", async () => {
    const ts = "2025-01-01T00:00:10.000Z";
    const receipt = "2025-01-01T00:00:12.000Z";
    const sequence = [
      event("BTC-USD", 10), event("ETH-USD", 5),
      event("BTC-USD", 11), event("BTC-USD", 12),
      event("BTC-USD", 13, { timestamp: ts, receivedAt: receipt }),
      event("BTC-USD", 14, { timestamp: ts, receivedAt: receipt }),
      event("BTC-USD", 1), event("BTC-USD", 12), event("BTC-USD", 1),
      event("BTC-USD", 20, { timestamp: "2025-01-01T01:00:00+01:00", receivedAt: receipt }),
    ];
    for (const document of sequence) {
      for (const collection of Object.values(collections)) await upsertEvent(collection, document);
      await compare();
      await prune(document.symbol);
    }
    expect((await ordered(collections.reference)).filter((doc) => doc.symbol === "ETH-USD")).toHaveLength(1);
  });

  test.each(["read", "delete", "partial"])("propagates %s failure and converges after retry", async (failure) => {
    await seed(Array.from({ length: 10 }, (_, index) => event("BTC-USD", index)));
    const message = `injected ${failure}`;
    for (const name of names) {
      const collection = collections[name];
      const hooks = failure === "read"
        ? { beforeRead: async () => { throw new Error(message); } }
        : { beforeDelete: async (filter) => {
            if (failure === "partial") {
              const ids = await collection.find(filter).sort({ _id: 1 }).limit(2).project({ _id: 1 }).toArray();
              await collection.deleteMany({ _id: { $in: ids.map((item) => item._id) } });
            }
            throw new Error(message);
          } };
      await expect(algorithms[name](collection, "BTC-USD", target, hooks)).rejects.toThrow(message);
    }
    await compare();
    // A fresh invocation represents recovery without in-memory retention state.
    await prune("BTC-USD");
    expect(await collections.reference.countDocuments({ symbol: "BTC-USD" })).toBe(target);
  });

  test("boundary range is not equivalent to materialized IDs with a concurrent old insert", async () => {
    await seed(Array.from({ length: 5 }, (_, index) => event("BTC-USD", index)));
    const concurrent = event("BTC-USD", -10);
    for (const name of ["reference", "boundary"]) {
      await algorithms[name](collections[name], "BTC-USD", target, {
        beforeDelete: () => collections[name].insertOne(concurrent),
      });
    }
    expect(await collections.reference.findOne({ _id: concurrent._id })).not.toBeNull();
    expect(await collections.boundary.findOne({ _id: concurrent._id })).toBeNull();
  });
});
