const { randomUUID } = require("node:crypto");
const { MongoClient, Long } = require("mongodb");
const { createCommitReconciliation } = require("../src/commitReconciliation");

const uri = process.env.MONGO_INTEGRATION_URI;
const describeWithMongo = uri ? describe : describe.skip;

describeWithMongo("bounded decision cleanup with MongoDB", () => {
  jest.setTimeout(60000);
  const dbName = `decision_cleanup_test_${randomUUID().replace(/-/g, "")}`;
  let client;
  let db;
  let collection;
  let worker;
  let reports;
  let log;

  function document(partition, offset, extra = {}) {
    return {
      _id: JSON.stringify(["prices", partition, String(offset)]),
      groupId: "group", topic: "prices", partition, offset: Long.fromString(String(offset)),
      alertCandidate: null, previousPrice: null, percentChange: 0, ...extra,
    };
  }

  async function waitForReport(trigger, from = 0) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const report = reports.slice(from).find((item) => item.triggers.includes(trigger));
      if (report) return report;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${trigger}`);
  }

  beforeAll(async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
  });

  beforeEach(async () => {
    reports = [];
    log = jest.spyOn(console, "log").mockImplementation((label, payload) => {
      if (label === "Commit reconciliation:") reports.push(JSON.parse(payload));
    });
    collection = db.collection(`decisions_${randomUUID().replace(/-/g, "")}`);
    await collection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, {
      name: "decision_group_topic_partition_offset",
    });
    await collection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1, _id: 1 }, {
      name: "decision_cleanup_pagination",
    });
  });

  afterEach(async () => {
    if (worker) await worker.drain();
    worker = undefined;
    log.mockRestore();
  });

  afterAll(async () => {
    try { if (db) await db.dropDatabase(); } finally { if (client) await client.close(); }
  });

  it("deletes only validated decisions strictly below the revalidated long boundary", async () => {
    const high = "9007199254740994";
    const positive = {
      symbol: "BTC-USD", alertType: "SPIKE", message: "test", percentChange: 1,
      timestamp: "2025-01-01T00:00:00.000Z", comparisonTimestamp: "2024-12-31T23:59:00.000Z",
      previousPrice: 100, currentPrice: 101, windowMs: 60000,
    };
    const docs = [
      document(0, "9007199254740992", { alertCandidate: positive }),
      document(0, "9007199254740993"),
      document(0, high), document(0, "9007199254740995"),
      document(1, "1"), document(0, "1", { groupId: "other" }),
      document(0, "2", { groupId: ["group"] }),
      document(0, "3", { topic: ["prices"] }),
      document(0, "4", { alertCandidate: { invalid: true } }),
      { _id: "legacy", alertCandidate: null },
      { _id: "partial", groupId: "group", topic: "prices", partition: 0 },
      { _id: "wrong", groupId: "group", topic: "prices", partition: 0, offset: Long.ONE },
    ];
    await collection.insertMany(docs);
    const admin = {
      connect: jest.fn(), disconnect: jest.fn(),
      fetchOffsets: jest.fn().mockResolvedValue([{ topic: "prices", partitions: [
        { partition: 0, offset: high }, { partition: 1, offset: "-1" },
      ] }]),
    };
    worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices", cleanupEnabled: true });
    worker.start();
    const report = await waitForReport("startup");
    expect(report.cleanup).toMatchObject({ deleted: 2, batchesAttempted: 1 });
    const remaining = await collection.find().toArray();
    expect(new Set(remaining.map((item) => item._id))).toEqual(new Set(docs.slice(2).map((item) => item._id)));
    const explanation = await collection.find({
      groupId: "group", topic: "prices", partition: 0,
      offset: { $type: "long", $gte: Long.ZERO, $lt: Long.fromString(high) },
    }).hint("decision_group_topic_partition_offset").sort({ offset: 1 }).limit(500).explain();
    expect(JSON.stringify(explanation.queryPlanner.winningPlan)).toContain("decision_group_topic_partition_offset");
  });

  it("caps batches at 500 and automatically finishes without another notification", async () => {
    await collection.insertMany(Array.from({ length: 502 }, (_, offset) => document(0, offset)));
    const admin = {
      connect: jest.fn(), disconnect: jest.fn(),
      fetchOffsets: jest.fn().mockResolvedValue([{ topic: "prices", partitions: [{ partition: 0, offset: "501" }] }]),
    };
    worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices", cleanupEnabled: true });
    worker.start();
    expect((await waitForReport("startup")).cleanup).toMatchObject({
      deleted: 500, workLimitReached: true, followUpScheduled: true,
    });
    expect((await waitForReport("catch-up")).cleanup.deleted).toBe(1);
    expect((await collection.find().toArray()).map((item) => item._id)).toEqual([document(0, 501)._id]);
  });

  it("rechecks metadata and the decision snapshot at deletion time", async () => {
    const item = document(0, 0);
    const changedGroup = document(0, 1);
    await collection.insertMany([item, changedGroup]);
    const wrapper = {
      find: (...args) => collection.find(...args),
      deleteMany: async (filter, options) => {
        await collection.updateOne({ _id: item._id }, { $set: { alertCandidate: { invalid: true } } });
        await collection.updateOne({ _id: changedGroup._id }, { $set: { groupId: ["group"] } });
        return collection.deleteMany(filter, options);
      },
    };
    const admin = {
      connect: jest.fn(), disconnect: jest.fn(),
      fetchOffsets: jest.fn().mockResolvedValue([{ topic: "prices", partitions: [{ partition: 0, offset: "2" }] }]),
    };
    worker = createCommitReconciliation({ admin, collection: wrapper, groupId: "group", topic: "prices", cleanupEnabled: true });
    worker.start();
    const report = await waitForReport("startup");
    expect(report.cleanup.partitions[0]).toMatchObject({ state: "partial", deleted: 0 });
    expect(await collection.countDocuments()).toBe(2);
  });

  it("makes bounded progress past 500 ambiguous records at the same offset", async () => {
    const invalid = Array.from({ length: 500 }, (_, index) =>
      document(0, 0, { _id: `!ambiguous-${String(index).padStart(3, "0")}` })
    );
    const sameOffset = document(0, 0);
    const good = document(0, 1);
    await collection.insertMany([...invalid, sameOffset, good]);
    const explain = await collection.find({
      groupId: "group", topic: "prices", partition: 0,
      offset: { $type: "long", $gte: Long.ZERO, $lt: Long.fromNumber(2) },
      _id: { $type: "string" },
    }).hint("decision_cleanup_pagination").sort({ offset: 1, _id: 1 }).limit(500).explain();
    const plan = JSON.stringify(explain.queryPlanner.winningPlan);
    expect(plan).toContain("decision_cleanup_pagination");
    expect(plan).not.toContain('"stage":"SORT"');
    const admin = {
      connect: jest.fn(), disconnect: jest.fn(),
      fetchOffsets: jest.fn().mockResolvedValue([{ topic: "prices", partitions: [{ partition: 0, offset: "2" }] }]),
    };
    worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices", cleanupEnabled: true });
    worker.start();
    await waitForReport("startup");
    await waitForReport("catch-up");
    expect(await collection.findOne({ _id: sameOffset._id })).toBeNull();
    expect(await collection.findOne({ _id: good._id })).toBeNull();
    expect(await collection.countDocuments()).toBe(500);
  });

  it("automatically drains several thousand committed decisions and preserves the boundary", async () => {
    await collection.insertMany(Array.from({ length: 3001 }, (_, offset) => document(0, offset)));
    const admin = {
      connect: jest.fn(), disconnect: jest.fn(),
      fetchOffsets: jest.fn().mockResolvedValue([{ topic: "prices", partitions: [{ partition: 0, offset: "3000" }] }]),
    };
    worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices", cleanupEnabled: true });
    worker.start();
    const deadline = Date.now() + 45000;
    while (!reports.some((report) => report.triggers.includes("catch-up") &&
        report.cleanup.followUpScheduled === false)) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for automatic catch-up");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(reports.reduce((sum, report) => sum + report.cleanup.deleted, 0)).toBe(3000);
    expect(reports.every((report) => report.cleanup.deleted <= 500)).toBe(true);
    expect((await collection.find().toArray()).map((item) => item._id)).toEqual([document(0, 3000)._id]);
    expect(admin.fetchOffsets.mock.calls.every(([options]) => options.resolveOffsets === false)).toBe(true);
  });

  it("retries after a partially applied deletion and worker restart without a notification", async () => {
    await collection.insertMany(Array.from({ length: 10 }, (_, offset) => document(0, offset)));
    let injected = false;
    const wrapper = {
      find: (...args) => collection.find(...args),
      deleteMany: async (filter, options) => {
        if (!injected) {
          injected = true;
          await collection.deleteMany({ _id: { $in: [document(0, 0)._id, document(0, 1)._id] } });
          throw new Error("injected partial deletion");
        }
        return collection.deleteMany(filter, options);
      },
    };
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const admin = {
        connect: jest.fn(), disconnect: jest.fn(),
        fetchOffsets: jest.fn().mockResolvedValue([{ topic: "prices", partitions: [{ partition: 0, offset: "8" }] }]),
      };
      worker = createCommitReconciliation({ admin, collection: wrapper, groupId: "group", topic: "prices", cleanupEnabled: true });
      worker.start();
      expect((await waitForReport("startup")).cleanup.deletionCountUncertain).toBe(true);
      expect(await collection.countDocuments()).toBe(8);
      await worker.drain();
      const from = reports.length;
      worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices", cleanupEnabled: true });
      worker.start();
      expect((await waitForReport("startup", from)).cleanup.deleted).toBe(6);
      expect((await collection.find().sort({ offset: 1 }).toArray()).map((item) => item._id))
        .toEqual([document(0, 8)._id, document(0, 9)._id]);
      expect(error).toHaveBeenCalledWith("Decision cleanup failed:", expect.stringContaining("injected partial deletion"));
    } finally {
      error.mockRestore();
    }
  });
});
