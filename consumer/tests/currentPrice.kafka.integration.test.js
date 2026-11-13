const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { Kafka, logLevel } = require("kafkajs");
const { MongoClient } = require("mongodb");
const { createCurrentPriceService } = require("../src/currentPriceConsumer");

const broker = process.env.KAFKA_INTEGRATION_BROKER;
const uri = process.env.MONGO_INTEGRATION_URI;
const describeIntegration = broker && uri ? describe : describe.skip;

describeIntegration("current-price consumer Kafka and MongoDB integration", () => {
  jest.setTimeout(120000);
  const suffix = randomUUID().replace(/-/g, "");
  const topic = `current-price-test-${suffix}`;
  const group = `current-price-test-${suffix}`;
  const otherGroup = `current-price-other-${suffix}`;
  const dbName = `current_price_kafka_test_${suffix}`;
  const kafka = new Kafka({ clientId: `current-price-test-${suffix}`, brokers: [broker], logLevel: logLevel.NOTHING });
  let admin, producer, client, db, collection, service, other, topicCreated = false;
  const services = [];
  const logs = [];

  async function waitFor(description, check) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${description}`);
  }
  async function committed(groupId) {
    const offsets = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false });
    return offsets[0].partitions[0].offset;
  }
  async function send(symbol, price) {
    await producer.send({
      topic, messages: [{ value: JSON.stringify({ symbol, price, timestamp: new Date().toISOString() }) }],
    });
  }
  async function startService({ disableCommit = false, failWrite = false } = {}) {
    const consumer = kafka.consumer({ groupId: group, retry: { retries: 0, restartOnFailure: async () => false } });
    let assigned = false;
    let fetchedAfterAssignment = false;
    let crash;
    const removeListeners = [
      consumer.on(consumer.events.GROUP_JOIN, ({ payload }) => {
        assigned = payload.memberAssignment[topic]?.includes(0) === true;
        fetchedAfterAssignment = false;
      }),
      consumer.on(consumer.events.REBALANCING, () => {
        assigned = false;
        fetchedAfterAssignment = false;
      }),
      // GROUP_JOIN precedes KafkaJS's initial offset resolution; FETCH follows it.
      consumer.on(consumer.events.FETCH, () => {
        if (assigned) fetchedAfterAssignment = true;
      }),
      consumer.on(consumer.events.CRASH, ({ payload }) => { crash = payload.error; }),
    ];
    if (disableCommit) {
      const run = consumer.run;
      consumer.run = (options) => run({ ...options, autoCommit: false });
    }
    const mongo = new MongoClient(uri);
    if (failWrite) {
      const originalDb = mongo.db.bind(mongo);
      mongo.db = (name) => {
        const realDb = originalDb(name);
        return { collection: (collectionName) => {
          const realCollection = realDb.collection(collectionName);
          let failed = false;
          return { updateOne: (...args) => {
            if (!failed) {
              failed = true;
              return Promise.reject(new Error("injected snapshot failure"));
            }
            return realCollection.updateOne(...args);
          } };
        } };
      };
    }
    const processObject = new EventEmitter();
    processObject.exit = jest.fn();
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn((...args) => logs.push(args)) };
    const instance = createCurrentPriceService({
      consumer, mongoClient: mongo, dbName, topic,
      symbols: ["BTC-USD", "ETH-USD", "SOL-USD"], processObject, logger, graceMs: 20000,
    });
    services.push(instance);
    try {
      await instance.start();
      await waitFor("current-price partition 0 assignment and completed fetch", () => {
        if (crash) throw new Error(`Current-price consumer crashed before readiness: ${crash.message}`);
        if (processObject.exit.mock.calls.length) {
          throw new Error(`Current-price consumer exited before readiness: ${JSON.stringify(logs)}`);
        }
        return assigned && fetchedAfterAssignment;
      });
    } finally {
      for (const remove of removeListeners) remove();
    }
    return instance;
  }

  beforeAll(async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(dbName);
    collection = db.collection("current_prices");
    admin = kafka.admin();
    await admin.connect();
    topicCreated = await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1, replicationFactor: 1 }] });
    if (!topicCreated) throw new Error("Disposable topic was not created");
    producer = kafka.producer();
    await producer.connect();
  });
  afterAll(async () => {
    const errors = [];
    async function cleanup(label, action) {
      try { await action(); } catch (error) { errors.push(`${label}: ${error.message}`); }
    }
    for (const instance of services) await cleanup("service", () => instance.shutdown("test cleanup"));
    if (other) await cleanup("other group", () => other.disconnect());
    if (producer) await cleanup("producer", () => producer.disconnect());
    if (admin && topicCreated) {
      await cleanup("groups", () => admin.deleteGroups([group, otherGroup]));
      await cleanup("topic", () => admin.deleteTopics({ topics: [topic] }));
    }
    if (admin) await cleanup("admin", () => admin.disconnect());
    if (db) await cleanup("database", () => db.dropDatabase());
    if (client) await cleanup("MongoDB", () => client.close());
    if (errors.length) throw new Error(errors.join("; "));
  });

  test("starts at the tail, resumes committed offsets, replays writes, and isolates another group", async () => {
    await send("BTC-USD", 10);
    other = kafka.consumer({ groupId: otherGroup });
    await other.connect();
    await other.subscribe({ topic, fromBeginning: true });
    await other.run({ eachMessage: async () => {} });
    await waitFor("independent group commit", async () => BigInt(await committed(otherGroup)) >= 1n);
    await other.disconnect();
    other = undefined;
    const otherBefore = await committed(otherGroup);

    expect(await committed(group)).toBe("-1");
    service = await startService();
    await send("ETH-USD", 20);
    await waitFor("new event", () => collection.findOne({ _id: "ETH-USD" }));
    await waitFor("current group commit", async () => BigInt(await committed(group)) >= 2n);
    expect(await collection.findOne({ _id: "BTC-USD" })).toBeNull();
    await service.shutdown("restart");

    service = await startService({ disableCommit: true });
    await send("BTC-USD", 30);
    const first = await waitFor("uncommitted snapshot", () => collection.findOne({ _id: "BTC-USD" }));
    expect(first.price).toBe(30);
    expect(await committed(group)).toBe("2");
    await service.shutdown("simulate interruption before commit");

    service = await startService();
    await waitFor("replayed event committed", async () => BigInt(await committed(group)) >= 3n);
    const replay = await collection.findOne({ _id: "BTC-USD" });
    expect(replay.price).toBe(30);
    expect(replay.receivedAt).toEqual(first.receivedAt);
    expect(await committed(otherGroup)).toBe(otherBefore);
    await service.shutdown("restart after replay");

    service = await startService({ failWrite: true });
    await send("SOL-USD", 40);
    await waitFor("injected write failure", () => logs.some((args) => args[0] === "Current-price processing failed:"));
    await service.shutdown("failure");
    expect(await collection.findOne({ _id: "SOL-USD" })).toBeNull();
    expect(await committed(group)).toBe("3");
    service = await startService();
    expect((await waitFor("retry snapshot", () => collection.findOne({ _id: "SOL-USD" }))).price).toBe(40);
    await waitFor("retry commit", async () => BigInt(await committed(group)) >= 4n);
    expect(await committed(otherGroup)).toBe(otherBefore);
  });
});
