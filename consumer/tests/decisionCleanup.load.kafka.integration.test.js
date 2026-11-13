const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { Kafka, logLevel } = require("kafkajs");
const { MongoClient, Long } = require("mongodb");
const { createCommitReconciliation } = require("../src/commitReconciliation");

const broker = process.env.KAFKA_INTEGRATION_BROKER;
const mongoUri = process.env.MONGO_INTEGRATION_URI;
const describeIntegration = broker && mongoUri ? describe : describe.skip;

async function waitFor(label, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function stats(values) {
  if (!values.length) return { count: 0, averageMs: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    averageMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    p95Ms: Number(sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(2)),
  };
}

describeIntegration("decision cleanup sustained Kafka workload", () => {
  jest.setTimeout(240000);
  const suffix = randomUUID().replace(/-/g, "");
  const topic = `cleanup-load-${suffix}`;
  const groupId = `cleanup-load-${suffix}`;
  const dbName = `cleanup_load_${suffix}`;
  const kafka = new Kafka({ clientId: `cleanup-load-${suffix}`, brokers: [broker], logLevel: logLevel.NOTHING });
  let mongo;
  let db;
  let collection;
  let admin;
  let producer;
  let consumer;
  let worker;
  let topicCreated = false;
  let log;
  let removeCommit;
  const reports = [];
  const batchDurations = [];
  const counts = { offsetFetches: 0, finds: 0, deletes: 0 };
  let totalSent = 0;
  let processed = 0;
  let signalCommits = false;

  beforeAll(async () => {
    log = jest.spyOn(console, "log").mockImplementation((label, payload) => {
      if (label === "Commit reconciliation:") reports.push(JSON.parse(payload));
    });
    mongo = new MongoClient(mongoUri);
    await mongo.connect();
    db = mongo.db(dbName);
    collection = db.collection("alert_decisions");
    await collection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, { name: "decision_group_topic_partition_offset" });
    await collection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1, _id: 1 }, { name: "decision_cleanup_pagination" });
    admin = kafka.admin();
    await admin.connect();
    topicCreated = await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1, replicationFactor: 1 }] });
    if (!topicCreated) throw new Error("Disposable topic creation failed");
    producer = kafka.producer();
    await producer.connect();
    consumer = kafka.consumer({ groupId, sessionTimeout: 10000, heartbeatInterval: 1000 });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });

    const workerAdmin = kafka.admin();
    const measuredAdmin = {
      connect: () => workerAdmin.connect(),
      disconnect: () => workerAdmin.disconnect(),
      fetchOffsets: (options) => { counts.offsetFetches += 1; return workerAdmin.fetchOffsets(options); },
    };
    const measuredCollection = {
      find: (...args) => { counts.finds += 1; return collection.find(...args); },
      deleteMany: async (...args) => {
        counts.deletes += 1;
        const start = performance.now();
        try { return await collection.deleteMany(...args); }
        finally { batchDurations.push(performance.now() - start); }
      },
    };
    worker = createCommitReconciliation({ admin: measuredAdmin, collection: measuredCollection, groupId, topic, cleanupEnabled: true });
    worker.start();
    await waitFor("worker startup", () => reports.find((r) => r.triggers.includes("startup")));
    removeCommit = consumer.on(consumer.events.COMMIT_OFFSETS, () => {
      if (signalCommits) worker.schedule("commit");
    });
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        await collection.insertOne({
          _id: JSON.stringify([topic, partition, message.offset]), groupId, topic, partition,
          offset: Long.fromString(message.offset), alertCandidate: null,
          previousPrice: null, percentChange: 0,
        });
        processed += 1;
      },
    });
  });

  afterAll(async () => {
    const errors = [];
    async function clean(label, action) {
      try { await action(); } catch (error) { errors.push(`${label}: ${error.message}`); }
    }
    if (removeCommit) removeCommit();
    if (worker) await clean("worker", () => worker.drain());
    if (consumer) await clean("consumer", () => consumer.disconnect());
    if (producer) await clean("producer", () => producer.disconnect());
    if (admin && topicCreated) {
      await clean("group", () => admin.deleteGroups([groupId]));
      await clean("topic", () => admin.deleteTopics({ topics: [topic] }));
    }
    if (admin) await clean("admin", () => admin.disconnect());
    if (db) await clean("database", () => db.dropDatabase());
    if (mongo) await clean("MongoDB", () => mongo.close());
    if (log) log.mockRestore();
    if (errors.length) throw new Error(errors.join("; "));
  });

  it("measures bounded catch-up and ongoing committed input", async () => {
    async function send(count, waitForCommit = true) {
      const start = totalSent;
      await producer.send({
        topic, messages: Array.from({ length: count }, (_, index) => ({ partition: 0, value: String(start + index) })),
      });
      totalSent += count;
      await waitFor("message callbacks", () => processed >= totalSent);
      if (waitForCommit) {
        await waitFor("broker commit", async () => {
          const response = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false });
          return response[0].partitions[0].offset === String(totalSent);
        });
      }
    }

    async function cycle(source) {
      const index = reports.length;
      worker.schedule(source);
      return waitFor(`cycle ${source}`, () => reports.slice(index).find((r) => r.triggers.includes(source)));
    }

    const cases = [];
    for (const size of [100, 500, 700, 3000]) {
      await send(size);
      const backlog = await collection.countDocuments();
      expect(backlog).toBe(size);
      const start = performance.now();
      const reportStart = reports.length;
      await cycle(`catchup-${size}`);
      await waitFor("automatic catch-up completion", () =>
        reports.slice(reportStart).find((report) => report.cleanup.followUpScheduled === false)
      );
      const cycles = reports.slice(reportStart).map((report) => report.cleanup.deleted);
      expect(await collection.countDocuments()).toBe(0);
      cases.push({ eligible: backlog, deletedPerCycle: cycles, drainMs: Number((performance.now() - start).toFixed(2)) });
      expect(cycles.reduce((sum, value) => sum + value, 0)).toBe(size);
      expect(cycles.every((count) => count <= 500)).toBe(true);
    }

    signalCommits = true;
    const streamBacklogs = [];
    const streamSize = 4000;
    const streamStart = performance.now();
    for (let round = 0; round < 20; round += 1) {
      await send(200, false);
      const observed = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false });
      const committed = observed[0].partitions[0].offset;
      streamBacklogs.push(committed === "-1" ? 0 : await collection.countDocuments({
        groupId, topic, partition: 0, offset: { $type: "long", $lt: Long.fromString(committed) },
      }));
    }
    await waitFor("last stream commit", async () => {
      const observed = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false });
      return observed[0].partitions[0].offset === String(totalSent);
    });
    const streamDurationMs = performance.now() - streamStart;
    signalCommits = false;
    const streamBarrierStart = reports.length;
    await cycle("stream-barrier");
    await waitFor("stream catch-up completion", () =>
      reports.slice(streamBarrierStart).find((report) => report.cleanup.followUpScheduled === false)
    );
    let remaining = await collection.countDocuments();
    let catchupCycles = 0;
    const catchupStart = performance.now();
    catchupCycles = reports.slice(streamBarrierStart).filter((report) => report.triggers.includes("catch-up")).length;
    remaining = await collection.countDocuments();
    expect(remaining).toBe(0);
    const totalDeleted = reports.reduce((sum, report) => sum + report.cleanup.deleted, 0);
    expect(totalDeleted).toBe(totalSent);
    expect(processed).toBe(totalSent);
    const cycleStats = stats(reports.map((report) => report.cleanup.durationMs).filter(Number.isFinite));
    const output = {
      cases, streamBacklogs, streamDrainCycles: catchupCycles,
      streamDurationMs: Number(streamDurationMs.toFixed(2)),
      streamInputPerSecond: Number((streamSize / (streamDurationMs / 1000)).toFixed(2)),
      streamDrainMs: Number((performance.now() - catchupStart).toFixed(2)),
      totalSent, totalDeleted, remaining, workerCycles: reports.length,
      counts, offsetFetchesPerCycle: Number((counts.offsetFetches / reports.length).toFixed(2)),
      cycle: cycleStats, deletionBatch: stats(batchDurations),
      catchupRecordsPerSecond: Number((cases.reduce((sum, item) => sum + item.eligible, 0) /
        (cases.reduce((sum, item) => sum + item.drainMs, 0) / 1000)).toFixed(2)),
    };
    process.stdout.write(`CLEANUP_LOAD_METRICS ${JSON.stringify(output)}\n`);
  });
});
