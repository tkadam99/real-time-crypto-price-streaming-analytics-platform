const { randomUUID } = require("node:crypto");
const { MongoClient, Long } = require("mongodb");
const { inspectEligible } = require("../src/commitReconciliation");

const uri = process.env.MONGO_INTEGRATION_URI;
const describeWithMongo = uri ? describe : describe.skip;

describeWithMongo("commit reconciliation MongoDB integration", () => {
  const dbName = `commit_reconcile_test_${randomUUID().replace(/-/g, "")}`;
  let client;
  let db;

  beforeAll(async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
  });

  afterAll(async () => {
    try {
      if (db) await db.dropDatabase();
    } finally {
      if (client) await client.close();
    }
  });

  it("uses the compound index for bounded numeric eligibility without modifying documents", async () => {
    const collection = db.collection("alert_decisions");
    await collection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, {
      name: "decision_group_topic_partition_offset",
    });
    const make = (offset, overrides = {}) => ({
      _id: JSON.stringify(["prices", 0, offset]),
      groupId: "group", topic: "prices", partition: 0, offset: Long.fromString(offset),
      ...overrides,
    });
    await collection.insertMany([
      make("9007199254740992"),
      make("9007199254740993"),
      make("9007199254740994"),
      make("9007199254740990", { groupId: "other" }),
      make("9007199254740989", { topic: "other" }),
      make("9007199254740988", { partition: 1 }),
      { _id: "legacy" },
      { _id: "partial", groupId: "group", topic: "prices", partition: 0 },
      { _id: "malformed", groupId: "group", topic: "prices", partition: 0, offset: Long.ONE },
    ]);
    const before = await collection.find().sort({ _id: 1 }).toArray();
    expect(await inspectEligible(collection, "group", "prices", 0, "9007199254740994"))
      .toEqual({ eligibleSampleCount: 2, inspectedSampleCount: 3 });
    expect(await collection.find().sort({ _id: 1 }).toArray()).toEqual(before);
  });

  it("limits the sample and uses the cleanup index", async () => {
    const collection = db.collection("bounded_decisions");
    const indexName = "decision_group_topic_partition_offset";
    await collection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, { name: indexName });
    await collection.insertMany(Array.from({ length: 110 }, (_, value) => ({
      _id: JSON.stringify(["prices", 0, String(value)]),
      groupId: "group", topic: "prices", partition: 0, offset: Long.fromNumber(value),
    })));
    const filter = {
      groupId: "group", topic: "prices", partition: 0,
      offset: { $type: "long", $gte: Long.ZERO, $lt: Long.fromNumber(110) },
    };
    const explanation = await collection.find(filter).hint(indexName).sort({ offset: 1 }).limit(100).explain();
    expect(JSON.stringify(explanation.queryPlanner.winningPlan)).toContain(indexName);
    expect(await inspectEligible(collection, "group", "prices", 0, "110"))
      .toEqual({ eligibleSampleCount: 100, inspectedSampleCount: 100 });
    expect(await collection.countDocuments()).toBe(110);
  });
});
