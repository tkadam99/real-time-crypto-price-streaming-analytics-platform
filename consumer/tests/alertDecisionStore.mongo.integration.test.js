const { randomUUID } = require("node:crypto");
const { MongoClient, Long } = require("mongodb");
const { createAlertDecisionStore } = require("../src/alertDecisionStore");
const { buildAlert } = require("../src/analytics");

const integrationUri = process.env.MONGO_INTEGRATION_URI;
const describeWithMongo = integrationUri ? describe : describe.skip;

describeWithMongo("alert decision store MongoDB integration", () => {
  const dbName = `decision_store_test_${randomUUID().replace(/-/g, "")}`;
  let client;
  let db;
  let store;

  beforeAll(async () => {
    client = new MongoClient(integrationUri);
    await client.connect();
    db = client.db(dbName);
    store = createAlertDecisionStore(db.collection("alert_decisions"), "test-group");
  });

  afterAll(async () => {
    try {
      if (db) await db.dropDatabase();
    } finally {
      if (client) await client.close();
    }
  });

  it("persists null and positive decisions with immutable first-writer wins", async () => {
    const identity = { topic: "isolated-topic", partition: 2, offset: "9007199254740993" };
    const empty = { alertCandidate: null, previousPrice: null, percentChange: 0 };
    const positive = {
      alertCandidate: buildAlert(
        "ETH-USD", 2, 102, 100, "2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z", 60000
      ),
      previousPrice: 100,
      percentChange: 2,
    };
    const id = JSON.stringify([identity.topic, identity.partition, identity.offset]);
    const metadata = { groupId: "test-group", topic: identity.topic, partition: identity.partition, offset: Long.fromString(identity.offset) };

    expect(await store.find(identity)).toBeNull();
    expect(await store.insertOriginal(identity, empty)).toEqual({ _id: id, ...metadata, ...empty });
    expect(await store.insertOriginal(identity, positive)).toEqual({ _id: id, ...metadata, ...empty });
    const secondStore = createAlertDecisionStore(db.collection("alert_decisions"), "test-group");
    expect(await secondStore.find(identity)).toEqual({ _id: id, ...metadata, ...empty });
    const otherGroup = createAlertDecisionStore(db.collection("alert_decisions"), "other-group");
    await expect(otherGroup.insertOriginal(identity, positive)).rejects.toThrow("Conflicting consumer group ownership");

    const positiveId = { ...identity, partition: 3 };
    const inserted = await store.insertOriginal(positiveId, positive);
    expect(inserted.alertCandidate).toEqual(positive.alertCandidate);
    expect(await secondStore.find(positiveId)).toEqual(inserted);

    const concurrentId = { ...identity, offset: "9007199254740994" };
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        store.insertOriginal(concurrentId, index % 2 ? empty : positive)
      )
    );
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(await store.find(concurrentId)).toEqual(results[0]);
    expect(await db.collection("alert_decisions").countDocuments()).toBe(3);
    expect((await db.collection("alert_decisions").indexes()).map((index) => index.name))
      .toEqual(["_id_"]);
  });

  it("preserves BSON Long for small offsets and leaves legacy records unchanged", async () => {
    const prices = db.collection("alert_decisions");
    const small = { topic: "small-topic", partition: 0, offset: "1" };
    const id = JSON.stringify([small.topic, small.partition, small.offset]);
    const decision = { alertCandidate: null, previousPrice: null, percentChange: 0 };
    expect(Long.isLong((await store.insertOriginal(small, decision)).offset)).toBe(true);
    expect(Long.isLong((await store.find(small)).offset)).toBe(true);

    const legacy = { topic: "legacy-topic", partition: 0, offset: "7" };
    const legacyId = JSON.stringify([legacy.topic, legacy.partition, legacy.offset]);
    await prices.insertOne({ _id: legacyId, ...decision });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await store.find(legacy)).toEqual({ _id: legacyId, ...decision });
      expect(await store.insertOriginal(legacy, decision)).toEqual({ _id: legacyId, ...decision });
      expect(await prices.findOne({ _id: legacyId })).toEqual({ _id: legacyId, ...decision });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(legacyId));
    } finally {
      warn.mockRestore();
    }
    expect(await prices.findOne({ _id: id }, { promoteLongs: false })).toMatchObject({
      offset: Long.fromInt(1),
    });
  });
});
