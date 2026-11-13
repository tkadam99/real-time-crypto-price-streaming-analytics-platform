const { randomUUID } = require("node:crypto");
const { Kafka, logLevel } = require("kafkajs");
const { MongoClient, Long } = require("mongodb");
const { createCommitReconciliation } = require("../src/commitReconciliation");

const broker = process.env.KAFKA_INTEGRATION_BROKER;
const mongoUri = process.env.MONGO_INTEGRATION_URI;
const describeIntegration = broker && mongoUri ? describe : describe.skip;

function deferred() {
  let resolve;
  const result = { done: false, value: undefined };
  result.promise = new Promise((done) => {
    resolve = (value) => {
      result.done = true;
      result.value = value;
      done(value);
    };
  });
  result.resolve = resolve;
  return result;
}

async function waitFor(description, check, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describeIntegration("commit reconciliation with real Kafka and MongoDB", () => {
  jest.setTimeout(120000);
  const suffix = randomUUID().replace(/-/g, "");
  const topic = `reconcile-test-${suffix}`;
  const groupId = `reconcile-test-${suffix}`;
  const dbName = `reconcile_test_${suffix}`;
  const kafka = new Kafka({ clientId: `reconcile-test-${suffix}`, brokers: [broker], logLevel: logLevel.NOTHING });
  const consumers = [];
  const workers = [];
  const gates = [];
  const reports = [];
  const errors = [];
  let mongo;
  let db;
  let admin;
  let producer;
  let collection;
  let topicCreated = false;
  let logSpy;
  let errorSpy;

  function gate() {
    const result = deferred();
    gates.push(result);
    return result;
  }

  async function offsets() {
    const result = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false });
    return Object.fromEntries(result[0].partitions.map(({ partition, offset }) => [partition, offset]));
  }

  async function reportFor(trigger, startIndex = reports.length) {
    return waitFor(`reconciliation ${trigger}`, () =>
      reports.slice(startIndex).find((report) => report.triggers.includes(trigger))
    );
  }

  async function createConsumer() {
    const consumer = kafka.consumer({
      groupId, sessionTimeout: 10000, heartbeatInterval: 1000,
      retry: { retries: 0, restartOnFailure: async () => false },
    });
    consumers.push(consumer);
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    return consumer;
  }

  function makeDecision(partition, offset, alertCandidate, override = {}) {
    return {
      _id: JSON.stringify([topic, partition, String(offset)]),
      groupId, topic, partition, offset: Long.fromNumber(offset),
      alertCandidate, previousPrice: null, percentChange: 0,
      ...override,
    };
  }

  beforeAll(async () => {
    logSpy = jest.spyOn(console, "log").mockImplementation((label, payload) => {
      if (label === "Commit reconciliation:") reports.push(JSON.parse(payload));
    });
    errorSpy = jest.spyOn(console, "error").mockImplementation((label, payload) => {
      if (label === "Commit reconciliation failed:") errors.push(JSON.parse(payload));
    });
    mongo = new MongoClient(mongoUri);
    await mongo.connect();
    db = mongo.db(dbName);
    collection = db.collection("alert_decisions");
    await collection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, {
      name: "decision_group_topic_partition_offset",
    });
    admin = kafka.admin();
    await admin.connect();
    topicCreated = await admin.createTopics({
      waitForLeaders: true, topics: [{ topic, numPartitions: 2, replicationFactor: 1 }],
    });
    if (!topicCreated) throw new Error("Isolated test topic was not created");
    producer = kafka.producer();
    await producer.connect();
  });

  afterAll(async () => {
    for (const item of gates) item.resolve();
    const errors = [];
    async function clean(label, action) {
      try { await action(); } catch (error) { errors.push(`${label}: ${error.message}`); }
    }
    for (const worker of workers) await clean("worker drain", () => worker.drain());
    for (const consumer of consumers) await clean("consumer disconnect", () => consumer.disconnect());
    if (producer) await clean("producer disconnect", () => producer.disconnect());
    if (admin && topicCreated) {
      await clean("test group deletion", () => admin.deleteGroups([groupId]));
      await clean("test topic deletion", () => admin.deleteTopics({ topics: [topic] }));
    }
    if (admin) await clean("admin disconnect", () => admin.disconnect());
    if (db) await clean("test database drop", () => db.dropDatabase());
    if (mongo) await clean("MongoDB disconnect", () => mongo.close());
    if (logSpy) logSpy.mockRestore();
    if (errorSpy) errorSpy.mockRestore();
    if (errors.length) throw new Error(`Isolated resource cleanup failed: ${errors.join("; ")}`);
  });

  it("observes only broker-committed boundaries across failures, partitions and restart", async () => {
    const positive = {
      symbol: "BTC-USD", alertType: "SPIKE", message: "test",
      percentChange: 1, timestamp: "2025-01-01T00:00:00.000Z",
      previousPrice: 100, currentPrice: 101,
      comparisonTimestamp: "2024-12-31T23:59:00.000Z", windowMs: 60000,
    };
    await collection.insertMany([
      makeDecision(0, 0, positive), makeDecision(0, 1, null),
      makeDecision(0, 2, null, { groupId: `${groupId}-other` }),
      makeDecision(0, 3, null), makeDecision(0, 4, null),
      makeDecision(1, 0, null), makeDecision(1, 3, positive),
      { _id: "legacy", alertCandidate: null },
      { _id: "partial", groupId, topic, partition: 0 },
      { _id: "invalid-identity", groupId, topic, partition: 0, offset: Long.ZERO },
    ]);
    const before = await collection.find().sort({ _id: 1 }).toArray();
    const cleanupCollection = db.collection("cleanup_test_decisions");
    await cleanupCollection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, {
      name: "decision_group_topic_partition_offset",
    });
    await cleanupCollection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1, _id: 1 }, {
      name: "decision_cleanup_pagination",
    });
    await cleanupCollection.insertMany(await collection.find({}, { promoteLongs: false }).toArray());
    await producer.send({
      topic, messages: [0, 1].flatMap((partition) =>
        [0, 1, 2].map((value) => ({ partition, value: `${partition}-${value}` }))),
    });
    expect(await offsets()).toEqual({ 0: "-1", 1: "-1" });

    const worker = createCommitReconciliation({ admin: kafka.admin(), collection, groupId, topic });
    workers.push(worker);
    let reportIndex = reports.length;
    worker.start();
    const initial = await reportFor("startup", reportIndex);
    expect(initial.partitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ partition: 0, state: "missing-or-uncertain", eligibleSampleCount: null }),
      expect.objectContaining({ partition: 1, state: "missing-or-uncertain", eligibleSampleCount: null }),
    ]));
    const cleanupWorker = createCommitReconciliation({
      admin: kafka.admin(), collection: cleanupCollection, groupId, topic, cleanupEnabled: true,
    });
    workers.push(cleanupWorker);
    reportIndex = reports.length;
    cleanupWorker.start();
    expect((await reportFor("startup", reportIndex)).cleanup.deleted).toBe(0);
    expect(await cleanupCollection.countDocuments()).toBe(before.length);

    const failed = deferred();
    const failureConsumer = await createConsumer();
    const crashed = deferred();
    failureConsumer.on(failureConsumer.events.CRASH, () => crashed.resolve());
    await failureConsumer.run({
      eachMessage: async () => { failed.resolve(); throw new Error("injected first-message failure"); },
    });
    await waitFor("first processing failure", () => failed.done);
    await waitFor("consumer crash", () => crashed.done);
    await failureConsumer.disconnect();
    expect(await offsets()).toEqual({ 0: "-1", 1: "-1" });
    reportIndex = reports.length;
    worker.schedule("after-failure");
    const afterFailure = await reportFor("after-failure", reportIndex);
    expect(afterFailure.partitions.every((p) => p.state === "missing-or-uncertain")).toBe(true);

    const secondP0 = gate();
    const firstP1 = gate();
    const reachedP0 = deferred();
    const reachedP1 = deferred();
    const consumer = await createConsumer();
    let commitCount = 0;
    const removeCommit = consumer.on(consumer.events.COMMIT_OFFSETS, () => {
      commitCount += 1;
      worker.schedule("commit");
    });
    await consumer.run({
      partitionsConsumedConcurrently: 2,
      eachMessage: async ({ partition, message }) => {
        if (partition === 0 && message.offset === "1") {
          reachedP0.resolve();
          await secondP0.promise;
        }
        if (partition === 1 && message.offset === "0") {
          reachedP1.resolve();
          await firstP1.promise;
        }
      },
    });
    await waitFor("partition 0 second callback", () => reachedP0.done);
    await waitFor("partition 1 first callback", () => reachedP1.done);
    expect(await offsets()).toEqual({ 0: "-1", 1: "-1" });
    reportIndex = reports.length;
    worker.schedule("before-commit");
    expect((await reportFor("before-commit", reportIndex)).partitions.every(
      (p) => p.state === "missing-or-uncertain"
    )).toBe(true);

    reportIndex = reports.length;
    secondP0.resolve();
    await waitFor("partition 0 broker commit", async () => (await offsets())[0] === "3");
    await waitFor("commit instrumentation", () => commitCount > 0);
    const committed = await waitFor("commit-triggered boundary", () =>
      reports.slice(reportIndex).find((r) => r.triggers.includes("commit") &&
        r.partitions.some((p) => p.partition === 0 && p.committedNextOffset === "3"))
    );
    expect(committed.partitions.find((p) => p.partition === 0)).toMatchObject({
      state: "verified", committedNextOffset: "3", eligibleSampleCount: 2, inspectedSampleCount: 3,
    });
    expect(committed.partitions.find((p) => p.partition === 1)).toMatchObject({
      state: "missing-or-uncertain", eligibleSampleCount: null,
    });
    expect(await offsets()).toEqual({ 0: "3", 1: "-1" });
    reportIndex = reports.length;
    cleanupWorker.schedule("cleanup-committed");
    const cleaned = await reportFor("cleanup-committed", reportIndex);
    expect(cleaned.cleanup).toMatchObject({ enabled: true, deleted: 2 });
    expect(await cleanupCollection.findOne({ _id: makeDecision(0, 0, null)._id })).toBeNull();
    expect(await cleanupCollection.findOne({ _id: makeDecision(0, 1, null)._id })).toBeNull();
    expect(await cleanupCollection.findOne({ _id: makeDecision(0, 3, null)._id })).not.toBeNull();
    expect(await cleanupCollection.findOne({ _id: makeDecision(1, 0, null)._id })).not.toBeNull();
    await cleanupWorker.drain();

    removeCommit();
    firstP1.resolve();
    await waitFor("partition 1 broker commit", async () => (await offsets())[1] === "3");
    reportIndex = reports.length;
    worker.schedule("manual-after-missed-notification");
    const manual = await reportFor("manual-after-missed-notification", reportIndex);
    expect(manual.partitions.find((p) => p.partition === 1)).toMatchObject({
      committedNextOffset: "3", eligibleSampleCount: 1,
    });

    const rebalanceCollection = db.collection("rebalance_cleanup");
    await rebalanceCollection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, {
      name: "decision_group_topic_partition_offset",
    });
    await rebalanceCollection.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1, _id: 1 }, {
      name: "decision_cleanup_pagination",
    });
    await rebalanceCollection.insertOne(makeDecision(1, 0, null));
    const rebalanceAdmin = kafka.admin();
    const revalidationStarted = deferred();
    const revalidationGate = gate();
    let revalidationCalls = 0;
    const guardedAdmin = {
      connect: () => rebalanceAdmin.connect(),
      disconnect: () => rebalanceAdmin.disconnect(),
      fetchOffsets: async (options) => {
        revalidationCalls += 1;
        if (revalidationCalls === 2) {
          revalidationStarted.resolve();
          await revalidationGate.promise;
        }
        return rebalanceAdmin.fetchOffsets(options);
      },
    };
    const rebalanceWorker = createCommitReconciliation({
      admin: guardedAdmin, collection: rebalanceCollection, groupId, topic, cleanupEnabled: true,
    });
    workers.push(rebalanceWorker);
    const rebalanceReportIndex = reports.length;
    rebalanceWorker.start();
    await waitFor("cleanup revalidation before rebalance", () => revalidationStarted.done);
    const joined = deferred();
    const secondJoined = deferred();
    const removeJoin = consumer.on(consumer.events.GROUP_JOIN, (event) => {
      joined.resolve(event.payload.memberAssignment);
      worker.schedule("group-join");
    });
    const secondConsumer = await createConsumer();
    secondConsumer.on(secondConsumer.events.GROUP_JOIN, (event) => {
      secondJoined.resolve(event.payload.memberAssignment);
    });
    reportIndex = reports.length;
    await secondConsumer.run({ eachMessage: async () => {} });
    await waitFor("first member rejoin", () => joined.done);
    await waitFor("second member join", () => secondJoined.done);
    const assignments = [joined.value, secondJoined.value]
      .flatMap((assignment) => assignment[topic] || []).sort();
    expect(assignments).toEqual([0, 1]);
    await reportFor("group-join", reportIndex);
    revalidationGate.resolve();
    const duringRebalance = await reportFor("startup", rebalanceReportIndex);
    expect(duringRebalance.cleanup.deleted).toBe(1);
    expect(await rebalanceCollection.countDocuments()).toBe(0);
    await rebalanceWorker.drain();
    removeJoin();
    await secondConsumer.disconnect();
    await consumer.disconnect();

    await producer.send({ topic, messages: [{ partition: 0, value: "restart-3" }] });
    const restartGate = gate();
    const replay = deferred();
    const restarted = await createConsumer();
    await restarted.run({
      eachMessage: async ({ partition, message }) => {
        replay.resolve({ partition, offset: message.offset });
        await restartGate.promise;
      },
    });
    const firstAfterRestart = await waitFor("restart replay", () => replay.value);
    expect(firstAfterRestart).toEqual({ partition: 0, offset: "3" });
    expect(await offsets()).toEqual({ 0: "3", 1: "3" });
    reportIndex = reports.length;
    const restartedWorker = createCommitReconciliation({ admin: kafka.admin(), collection, groupId, topic });
    workers.push(restartedWorker);
    restartedWorker.start();
    const restartReport = await reportFor("startup", reportIndex);
    expect(restartReport.partitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ partition: 0, committedNextOffset: "3", eligibleSampleCount: 2 }),
      expect.objectContaining({ partition: 1, committedNextOffset: "3", eligibleSampleCount: 1 }),
    ]));
    await restartedWorker.drain();
    const cleanupAfterRestart = createCommitReconciliation({
      admin: kafka.admin(), collection: cleanupCollection, groupId, topic, cleanupEnabled: true,
    });
    workers.push(cleanupAfterRestart);
    reportIndex = reports.length;
    cleanupAfterRestart.start();
    const resumedCleanup = await reportFor("startup", reportIndex);
    expect(resumedCleanup.cleanup.deleted).toBe(1);
    expect(await cleanupCollection.findOne({ _id: makeDecision(1, 0, null)._id })).toBeNull();
    expect(await cleanupCollection.findOne({ _id: makeDecision(1, 3, null)._id })).not.toBeNull();
    await cleanupAfterRestart.drain();

    const noIndex = await db.createCollection("missing_index_test");
    const failingWorker = createCommitReconciliation({ admin: kafka.admin(), collection: noIndex, groupId, topic });
    workers.push(failingWorker);
    reportIndex = reports.length;
    failingWorker.start();
    const failedQuery = await reportFor("startup", reportIndex);
    expect(failedQuery.partitions.every((p) => p.state === "inspection-failed")).toBe(true);
    expect(failedQuery.retry).toBe("next trigger or periodic cycle");
    await noIndex.createIndex({ groupId: 1, topic: 1, partition: 1, offset: 1 }, {
      name: "decision_group_topic_partition_offset",
    });
    reportIndex = reports.length;
    failingWorker.schedule("after-index-restored");
    const recovered = await reportFor("after-index-restored", reportIndex);
    expect(recovered.partitions.every((p) => p.state === "verified")).toBe(true);
    await failingWorker.drain();

    const retryAdmin = kafka.admin();
    let failFetch = true;
    const retryWorker = createCommitReconciliation({
      admin: {
        connect: () => retryAdmin.connect(),
        disconnect: () => retryAdmin.disconnect(),
        fetchOffsets: (options) => {
          if (failFetch) {
            failFetch = false;
            return Promise.reject(new Error("injected offset fetch failure"));
          }
          return retryAdmin.fetchOffsets(options);
        },
      },
      collection, groupId, topic,
    });
    workers.push(retryWorker);
    retryWorker.start();
    await waitFor("reported broker fetch failure", () =>
      errors.find((entry) => entry.error === "injected offset fetch failure")
    );
    reportIndex = reports.length;
    retryWorker.schedule("after-fetch-failure");
    const fetchRecovered = await reportFor("after-fetch-failure", reportIndex);
    expect(fetchRecovered.partitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ partition: 0, committedNextOffset: "3", eligibleSampleCount: 2 }),
    ]));
    await retryWorker.drain();

    const realAdmin = kafka.admin();
    const fetchGate = gate();
    const fetchStarted = deferred();
    let disconnected = false;
    const delayedAdmin = {
      connect: () => realAdmin.connect(),
      fetchOffsets: async (options) => {
        fetchStarted.resolve();
        await fetchGate.promise;
        return realAdmin.fetchOffsets(options);
      },
      disconnect: async () => { await realAdmin.disconnect(); disconnected = true; },
    };
    const drainingWorker = createCommitReconciliation({ admin: delayedAdmin, collection, groupId, topic });
    workers.push(drainingWorker);
    drainingWorker.start();
    await waitFor("delayed broker fetch", () => fetchStarted.done);
    const draining = drainingWorker.drain();
    expect(disconnected).toBe(false);
    fetchGate.resolve();
    await draining;
    expect(disconnected).toBe(true);
    expect(await collection.find().sort({ _id: 1 }).toArray()).toEqual(before);
    restartGate.resolve();
    await restarted.disconnect();

    await admin.setOffsets({
      groupId, topic, partitions: [{ partition: 0, offset: "0" }, { partition: 1, offset: "3" }],
    });
    expect(await offsets()).toEqual({ 0: "0", 1: "3" });
    const rewindGate = gate();
    const rewoundMessage = deferred();
    const rewound = await createConsumer();
    await rewound.run({
      eachMessage: async ({ partition, message }) => {
        rewoundMessage.resolve({ partition, offset: message.offset });
        await rewindGate.promise;
      },
    });
    await waitFor("isolated rewind replay", () => rewoundMessage.done);
    expect(rewoundMessage.value).toEqual({ partition: 0, offset: "0" });
    expect(await cleanupCollection.findOne({ _id: makeDecision(0, 0, null)._id })).toBeNull();
    rewindGate.resolve();
    await rewound.disconnect();
  });
});
