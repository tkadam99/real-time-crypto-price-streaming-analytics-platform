const { Collection, Db, MongoClient } = require("mongodb");
const {
  HISTORY_CONSUMER_GROUP_ID,
  HISTORY_DATABASE_NAME,
  HISTORY_KAFKA_CLUSTER_ID,
  HISTORY_TOPIC,
  LIVE_START_ACKNOWLEDGEMENT,
  loadHistoryConsumerConfig,
} = require("../v2/historyConsumerConfig");
const { HISTORY_COLLECTION_NAMES } = require("../v2/historyCollectionInspection");
const {
  createHistoryConsumerStartup,
} = require("../v2/historyConsumerStartup");

const config = loadHistoryConsumerConfig({
  V2_HISTORY_CONSUMER_ENABLED: "true",
  V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
});
const topicMetadata = {
  topics: [{
    name: HISTORY_TOPIC,
    partitions: [0, 1, 2, 3, 4, 5].map((partitionId) => ({
      partitionId,
      leader: 1,
      partitionErrorCode: 0,
    })),
  }],
};

function createHarness({
  startupConfig = config,
  clusterId = HISTORY_KAFKA_CLUSTER_ID,
  mongoHello,
  mongoStatus,
  ensureIndexes,
  persistHistoryBatchImpl = jest.fn(async () => ({ inserted: 0, replay: 0, failed: 0 })),
  runnerStart = jest.fn(async () => {}),
  runnerStop = jest.fn(async () => {}),
  connectAdmin = jest.fn(async () => {}),
  connectMongo = jest.fn(async () => {}),
  connectConsumer = jest.fn(async () => {}),
  verifyPreflights,
  historyCollectionOverride,
  receiptCollectionOverride,
  verifyOwnership,
} = {}) {
  const events = [];
  const ensureIndexesImpl = ensureIndexes ||
    jest.fn(async () => { events.push("indexes.ensure"); });
  const verifyOwnershipImpl = verifyOwnership ||
    jest.fn(async () => {
      events.push("ownership.verify");
      return {
        databaseName: HISTORY_DATABASE_NAME,
        status: "verified",
        collections: {
          history: HISTORY_COLLECTION_NAMES.history,
          receipts: HISTORY_COLLECTION_NAMES.receipts,
        },
      };
    });
  let resolveTerminal;
  const terminalSignal = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const adminDatabase = {
    command: jest.fn(async (command) => {
      if (command.hello === 1) {
        events.push("mongo.hello");
        return mongoHello || {
          setName: "rs-v2",
          isWritablePrimary: true,
          me: "v2-mongodb:27017",
        };
      }
      events.push("mongo.replSetGetStatus");
      return mongoStatus || {
        set: "rs-v2",
        members: [{
          name: "v2-mongodb:27017",
          stateStr: "PRIMARY",
          self: true,
        }],
      };
    }),
  };
  const mongoClient = new MongoClient(startupConfig.mongo.uri);
  const getDatabase = mongoClient.db.bind(mongoClient);
  const historyDatabase = getDatabase(startupConfig.mongo.databaseName);
  mongoClient.db = jest.fn((name) => {
    events.push(`mongo.db:${name}`);
    return name === "admin" ? adminDatabase : getDatabase(name);
  });
  mongoClient.connect = jest.fn(async () => {
    events.push("mongo.connect");
    return connectMongo();
  });
  mongoClient.close = jest.fn(async () => { events.push("mongo.close"); });
  const admin = {
    connect: jest.fn(async () => {
      events.push("kafka.admin.connect");
      return connectAdmin();
    }),
    disconnect: jest.fn(async () => { events.push("kafka.admin.disconnect"); }),
    describeCluster: jest.fn(async () => {
      events.push("kafka.describeCluster");
      return { clusterId };
    }),
    fetchTopicMetadata: jest.fn(async () => {
      events.push("kafka.fetchTopicMetadata");
      return topicMetadata;
    }),
  };
  const historyCollection = typeof historyCollectionOverride === "function"
    ? historyCollectionOverride({ mongoClient, historyDatabase })
    : historyCollectionOverride ||
    historyDatabase.collection("injected-history-collection");
  const receiptCollection = receiptCollectionOverride ||
    historyDatabase.collection("injected-receipt-collection");
  const consumer = {
    connect: jest.fn(async () => {
      events.push("consumer.connect");
      return connectConsumer();
    }),
    disconnect: jest.fn(async () => { events.push("consumer.disconnect"); }),
    stop: jest.fn(async () => { events.push("consumer.stop"); }),
  };
  const createConsumer = jest.fn((options) => {
    events.push("consumer.create");
    return consumer;
  });
  let runnerConsumer;
  const runner = {
    start: jest.fn(async () => {
      events.push("runner.start");
      return runnerStart();
    }),
    stop: jest.fn(async () => {
      events.push("runner.stop");
      await runnerStop();
      if (runnerConsumer) await runnerConsumer.stop();
    }),
    waitForTerminalFailure: jest.fn(() => terminalSignal),
  };
  const createRunner = jest.fn((options) => {
    events.push("runner.create");
    runnerConsumer = options.consumer;
    return runner;
  });
  const onFailure = jest.fn();
  let startup;
  let startupError;
  try {
    startup = createHistoryConsumerStartup({
      config: startupConfig,
      admin,
      mongoClient,
      historyCollection,
      receiptCollection,
      createConsumer,
      ensureIndexes: ensureIndexesImpl,
      verifyPreflights,
      verifyOwnership: verifyOwnershipImpl,
      persistHistoryBatchImpl,
      createRunner,
      onFailure,
    });
  } catch (error) {
    startupError = error;
  }

  return {
    admin,
    adminDatabase,
    consumer,
    createConsumer,
    createRunner,
    events,
    ensureIndexes: ensureIndexesImpl,
    historyCollection,
    mongoClient,
    onFailure,
    persistHistoryBatchImpl,
    resolveTerminal,
    receiptCollection,
    runner,
    verifyOwnership: verifyOwnershipImpl,
    startup,
    startupError,
  };
}

test("completes identity checks and indexes before creating and starting the consumer", async () => {
  const harness = createHarness();

  expect(harness.mongoClient).toBeInstanceOf(MongoClient);
  expect(harness.historyCollection).toBeInstanceOf(Collection);
  expect(harness.historyCollection.db).toBeInstanceOf(Db);
  expect(harness.historyCollection.db.client).toBe(harness.mongoClient);

  await expect(harness.startup.start()).resolves.toBe(harness.runner);
  expect(harness.events).toEqual([
    "kafka.admin.connect",
    "mongo.connect",
    "kafka.describeCluster",
    "kafka.fetchTopicMetadata",
    "mongo.db:admin",
    "mongo.hello",
    "mongo.replSetGetStatus",
    "ownership.verify",
    "kafka.admin.disconnect",
    "indexes.ensure",
    "consumer.create",
    "runner.create",
    "consumer.connect",
    "runner.start",
  ]);
  expect(harness.ensureIndexes).toHaveBeenCalledWith({
    historyCollection: harness.historyCollection,
    receiptCollection: harness.receiptCollection,
  });
  expect(harness.verifyOwnership).toHaveBeenCalledWith({
    database: harness.historyCollection.db,
    mongoClient: harness.mongoClient,
    historyCollection: harness.historyCollection,
    receiptCollection: harness.receiptCollection,
  });
  expect(harness.events.indexOf("ownership.verify"))
    .toBeLessThan(harness.events.indexOf("indexes.ensure"));
  expect(harness.createConsumer).toHaveBeenCalledWith({
    broker: config.kafka.broker,
    connectionTimeout: config.kafka.options.connectionTimeout,
    requestTimeout: config.kafka.options.requestTimeout,
    groupId: HISTORY_CONSUMER_GROUP_ID,
    sessionTimeout: config.consumer.sessionTimeoutMs,
    heartbeatInterval: config.consumer.heartbeatIntervalMs,
    allowAutoTopicCreation: false,
  });
  expect(harness.createRunner.mock.calls[0][0].config.groupId)
    .toBe(harness.createConsumer.mock.calls[0][0].groupId);
  expect(harness.createRunner.mock.calls[0][0].config.heartbeatTimeoutMs)
    .toBe(config.consumer.heartbeatTimeoutMs);
  expect(typeof harness.createRunner.mock.calls[0][0].persistBatch).toBe("function");
  await harness.createRunner.mock.calls[0][0].persistBatch([{ event: "mock-envelope" }]);
  expect(harness.persistHistoryBatchImpl).toHaveBeenCalledWith({
    client: harness.mongoClient,
    historyCollection: harness.historyCollection,
    receiptCollection: harness.receiptCollection,
    envelopes: [{ event: "mock-envelope" }],
    batchSize: config.history.batchSize,
    concurrency: config.history.concurrency,
  });
  await harness.startup.stop();
});

test("rejects disabled configuration before attempting connections", () => {
  const harness = createHarness({
    startupConfig: { ...config, enabled: false },
  });

  expect(harness.startupError.message).toBe(
    "Invalid or disabled pinned V2 history startup configuration.",
  );
  expect(harness.admin.connect).not.toHaveBeenCalled();
  expect(harness.mongoClient.connect).not.toHaveBeenCalled();
});

test("rejects real collections from another database before connecting", () => {
  const rejected = createHarness({
    historyCollectionOverride: ({ mongoClient }) => mongoClient
      .db("crypto_analytics")
      .collection("history"),
  });

  expect(rejected.startupError.message).toBe(
    "V2 history collections must belong to the pinned V2 MongoDB client and database.",
  );
  expect(rejected.admin.connect).not.toHaveBeenCalled();
  expect(rejected.mongoClient.connect).not.toHaveBeenCalled();
});

test("rejects real collections from another MongoDB client before connecting", () => {
  const otherClient = new MongoClient(config.mongo.uri);
  const otherClientCollection = otherClient
    .db(config.mongo.databaseName)
    .collection("history");
  const harness = createHarness({
    historyCollectionOverride: otherClientCollection,
  });

  expect(harness.startupError.message).toBe(
    "V2 history collections must belong to the pinned V2 MongoDB client and database.",
  );
  expect(harness.admin.connect).not.toHaveBeenCalled();
  expect(harness.mongoClient.connect).not.toHaveBeenCalled();
});

test("Kafka identity failure prevents indexes and consumer creation and cleans up", async () => {
  const harness = createHarness({ clusterId: "wrong-cluster" });

  await expect(harness.startup.start())
    .rejects.toThrow("V2 history startup failed during Kafka and MongoDB identity preflight.");
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("MongoDB identity failure prevents indexes and consumer creation", async () => {
  const harness = createHarness({
    mongoHello: {
      setName: "rs-v2",
      isWritablePrimary: false,
      me: "v2-mongodb:27017",
    },
  });

  await expect(harness.startup.start())
    .rejects.toThrow("V2 history startup failed during Kafka and MongoDB identity preflight.");
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("ownership verification failure is sanitized and prevents all later startup work", async () => {
  const verifyOwnership = jest.fn().mockRejectedValue(
    new Error("mongodb://private/secret with collection document"),
  );
  const harness = createHarness({ verifyOwnership });

  await expect(harness.startup.start())
    .rejects.toThrow("V2 history startup failed during history collection ownership verification.");

  expect(verifyOwnership).toHaveBeenCalledTimes(1);
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.events).not.toContain("indexes.ensure");
  expect(harness.events).not.toContain("consumer.create");
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
  expect(harness.consumer.disconnect).not.toHaveBeenCalled();
  expect(harness.startupError).toBeUndefined();
});

test("missing collection verification failure prevents index setup and consumer creation", async () => {
  const verifyOwnership = jest.fn().mockRejectedValue(
    new Error("An approved V2 history collection is missing."),
  );
  const harness = createHarness({ verifyOwnership });

  const failure = await harness.startup.start().catch((error) => error);

  expect(failure.message)
    .toBe("V2 history startup failed during history collection ownership verification.");
  expect(failure.message).not.toContain("approved V2 history collection is missing");
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("shutdown during ownership verification cancels startup and cleans up", async () => {
  let releaseOwnership;
  let notifyOwnership;
  const ownershipStarted = new Promise((resolve) => {
    notifyOwnership = resolve;
  });
  const verifyOwnership = jest.fn(() => {
    notifyOwnership();
    return new Promise((resolve) => {
      releaseOwnership = resolve;
    });
  });
  const harness = createHarness({ verifyOwnership });

  const starting = harness.startup.start();
  await ownershipStarted;
  const shuttingDown = harness.startup.stop();
  releaseOwnership({
    databaseName: HISTORY_DATABASE_NAME,
    status: "verified",
    collections: {
      history: HISTORY_COLLECTION_NAMES.history,
      receipts: HISTORY_COLLECTION_NAMES.receipts,
    },
  });

  await expect(starting).rejects.toThrow("V2 history startup cancelled.");
  await expect(shuttingDown).resolves.toBeUndefined();
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("index setup failure prevents Kafka consumer construction", async () => {
  const harness = createHarness({
    ensureIndexes: jest.fn().mockRejectedValue(new Error("mongodb://private/secret")),
  });

  await expect(harness.startup.start())
    .rejects.toThrow("V2 history startup failed during history index setup.");
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("runner startup failure cleans up the runner, consumer, admin, and MongoDB", async () => {
  const harness = createHarness({
    runnerStart: jest.fn().mockRejectedValue(new Error("credential=secret")),
  });

  await expect(harness.startup.start())
    .rejects.toThrow("V2 history startup failed during history runner startup.");
  expect(harness.runner.stop).toHaveBeenCalledTimes(1);
  expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("terminal runner failure is observable and triggers supervisor cleanup", async () => {
  const harness = createHarness();
  await harness.startup.start();

  harness.resolveTerminal({
    classification: "malformed-json",
    topic: HISTORY_TOPIC,
    partition: 2,
    offset: "17",
    payload: "must-not-escape",
  });
  const result = await harness.startup.waitForTerminalCleanup();

  expect(result).toEqual({
    failure: {
      classification: "malformed-json",
      topic: HISTORY_TOPIC,
      partition: 2,
      offset: "17",
    },
    cleanupFailure: null,
  });
  expect(harness.startup.getTerminalFailure()).toEqual(result.failure);
  expect(harness.runner.stop).toHaveBeenCalledTimes(1);
  expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("must-not-escape");
});

test("shutdown during a pending connection cancels startup and cleans up once", async () => {
  let releaseMongoConnect;
  let notifyMongoConnect;
  const mongoConnectStarted = new Promise((resolve) => {
    notifyMongoConnect = resolve;
  });
  const pendingMongoConnect = new Promise((resolve) => {
    releaseMongoConnect = resolve;
  });
  const harness = createHarness({
    connectMongo: jest.fn(() => {
      notifyMongoConnect();
      return pendingMongoConnect;
    }),
  });
  const starting = harness.startup.start();
  await mongoConnectStarted;
  const shuttingDown = harness.startup.stop();
  releaseMongoConnect();

  await expect(starting).rejects.toThrow("V2 history startup cancelled.");
  await expect(shuttingDown).resolves.toBeUndefined();
  expect(harness.events).not.toContain("kafka.describeCluster");
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("repeated shutdown shares cleanup and continues after one cleanup error", async () => {
  const harness = createHarness({
    runnerStop: jest.fn().mockRejectedValue(new Error("private shutdown detail")),
  });
  await harness.startup.start();

  const firstStop = harness.startup.stop();
  const secondStop = harness.startup.stop();
  expect(secondStop).toBe(firstStop);
  await expect(firstStop)
    .rejects.toThrow("V2 history shutdown cleanup failed: history runner stop.");
  expect(harness.runner.stop).toHaveBeenCalledTimes(1);
  expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("bounds shutdown waits and still attempts later cleanup after a runner hangs", async () => {
  jest.useFakeTimers();
  const shortConfig = {
    ...config,
    mongo: {
      ...config.mongo,
      options: { ...config.mongo.options, timeoutMS: 1000 },
    },
    consumer: { ...config.consumer, sessionTimeoutMs: 6000 },
  };
  const harness = createHarness({
    startupConfig: shortConfig,
    runnerStop: jest.fn(() => new Promise(() => {})),
  });
  await harness.startup.start();

  const shuttingDown = harness.startup.stop().then(
    () => null,
    (error) => error,
  );
  await jest.advanceTimersByTimeAsync(7000);
  const shutdownError = await shuttingDown;
  expect(shutdownError).toBeInstanceOf(Error);
  expect(shutdownError.message)
    .toBe("V2 history shutdown cleanup failed: history runner stop.");
  expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
  jest.useRealTimers();
});
