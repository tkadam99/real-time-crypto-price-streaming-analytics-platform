const { Collection, Db, MongoClient } = require("mongodb");
const {
  FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
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
const smokeConfig = loadHistoryConsumerConfig({
  V2_HISTORY_CONSUMER_ENABLED: "true",
  V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
  V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
  V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: "5",
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "1000",
  V2_HISTORY_TOPIC_ID: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
});
const smokeTopicResult = {
  topic: HISTORY_TOPIC,
  topicId: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  partitionCount: 6,
  partitionIds: [0, 1, 2, 3, 4, 5],
};
const smokeGroupResult = {
  status: "absent",
  groupId: HISTORY_CONSUMER_GROUP_ID,
};
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createShortShutdownConfig() {
  return {
    ...config,
    mongo: {
      ...config.mongo,
      options: { ...config.mongo.options, timeoutMS: 1000 },
    },
    consumer: { ...config.consumer, sessionTimeoutMs: 6000 },
  };
}

const topicMetadata = {
  topics: [{
    name: HISTORY_TOPIC,
    topicId: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
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
  verifyHistorySmokeTopicIdentity,
  verifyHistorySmokeGroup,
  executeHistorySmokeCommand,
  onMongoClose,
} = {}) {
  const events = [];
  const ensureIndexesImpl = ensureIndexes ||
    jest.fn(async () => { events.push("indexes.ensure"); });
  const verifyOwnershipImpl = verifyOwnership ||
    jest.fn(async () => {
      events.push("ownership.verify");
      const result = {
        databaseName: HISTORY_DATABASE_NAME,
        status: "verified",
        collections: {
          history: HISTORY_COLLECTION_NAMES.history,
          receipts: HISTORY_COLLECTION_NAMES.receipts,
        },
      };
      if (startupConfig.firstRunSmoke) {
        events.push("ownership.indexes.verify");
        result.indexes = {
          historyTtl: "verified",
          receiptsTtl: "absent",
        };
      }
      return result;
    });
  let smokeGroupVerificationCount = 0;
  const verifyHistorySmokeTopicIdentityImpl =
    verifyHistorySmokeTopicIdentity === undefined
      ? jest.fn(async ({ executeCommand }) => {
        events.push("smoke.topic.verify");
        if (typeof executeCommand !== "function") {
          throw new Error("Missing command executor.");
        }
        return smokeTopicResult;
      })
      : verifyHistorySmokeTopicIdentity;
  const verifyHistorySmokeGroupImpl =
    verifyHistorySmokeGroup === undefined
      ? jest.fn(async () => {
        smokeGroupVerificationCount += 1;
        events.push(`smoke.group.verify:${smokeGroupVerificationCount}`);
        return smokeGroupResult;
      })
      : verifyHistorySmokeGroup;
  const executeHistorySmokeCommandImpl =
    executeHistorySmokeCommand === undefined
      ? jest.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }))
      : executeHistorySmokeCommand;
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
  let notifyMongoClose;
  const mongoCloseStarted = new Promise((resolve) => {
    notifyMongoClose = resolve;
  });
  const historyDatabase = getDatabase(startupConfig.mongo.databaseName);
  mongoClient.db = jest.fn((name) => {
    events.push(`mongo.db:${name}`);
    return name === "admin" ? adminDatabase : getDatabase(name);
  });
  mongoClient.connect = jest.fn(async () => {
    events.push("mongo.connect");
    return connectMongo();
  });
  mongoClient.close = jest.fn(async () => {
    events.push("mongo.close");
    notifyMongoClose();
    if (onMongoClose) onMongoClose();
  });
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
    listGroups: jest.fn(async () => ({ groups: [] })),
    describeGroups: jest.fn(async () => ({ groups: [] })),
    fetchOffsets: jest.fn(async () => []),
  };
  const historyCollection = typeof historyCollectionOverride === "function"
    ? historyCollectionOverride({ mongoClient, historyDatabase })
    : historyCollectionOverride ||
    historyDatabase.collection("injected-history-collection");
  const receiptCollection = receiptCollectionOverride ||
    historyDatabase.collection("injected-receipt-collection");
  let notifyConsumerDisconnect;
  const consumerDisconnectStarted = new Promise((resolve) => {
    notifyConsumerDisconnect = resolve;
  });
  const consumer = {
    connect: jest.fn(async () => {
      events.push("consumer.connect");
      return connectConsumer();
    }),
    disconnect: jest.fn(async () => {
      events.push("consumer.disconnect");
      notifyConsumerDisconnect();
    }),
    stop: jest.fn(async () => { events.push("consumer.stop"); }),
    subscribe: jest.fn(async () => { events.push("consumer.subscribe"); }),
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
      verifyHistorySmokeTopicIdentity: verifyHistorySmokeTopicIdentityImpl,
      verifyHistorySmokeGroup: verifyHistorySmokeGroupImpl,
      executeHistorySmokeCommand: executeHistorySmokeCommandImpl,
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
    consumerDisconnectStarted,
    createConsumer,
    createRunner,
    events,
    ensureIndexes: ensureIndexesImpl,
    historyCollection,
    mongoClient,
    mongoCloseStarted,
    onFailure,
    persistHistoryBatchImpl,
    resolveTerminal,
    receiptCollection,
    runner,
    verifyOwnership: verifyOwnershipImpl,
    verifyHistorySmokeTopicIdentity: verifyHistorySmokeTopicIdentityImpl,
    verifyHistorySmokeGroup: verifyHistorySmokeGroupImpl,
    executeHistorySmokeCommand: executeHistorySmokeCommandImpl,
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

test("keeps MongoDB open after runner timeout while persistence settles independently", async () => {
  jest.useFakeTimers();
  try {
    const shortConfig = createShortShutdownConfig();
    const transaction = createDeferred();
    let batchPromise;
    const harness = createHarness({
      startupConfig: shortConfig,
      persistHistoryBatchImpl: jest.fn(() => transaction.promise),
      runnerStop: jest.fn(() => new Promise(() => {})),
    });
    await harness.startup.start();
    batchPromise = harness.createRunner.mock.calls[0][0]
      .persistBatch([{ event: "pending-persistence" }]);

    const shuttingDown = harness.startup.stop().then(
      () => null,
      (error) => error,
    );
    await jest.advanceTimersByTimeAsync(7000);
    const shutdownError = await shuttingDown;
    expect(shutdownError).toBeInstanceOf(Error);
    expect(shutdownError.message)
      .toBe("V2 history shutdown cleanup failed: history runner stop.");
    expect(harness.consumer.disconnect).not.toHaveBeenCalled();
    expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.mongoClient.close).not.toHaveBeenCalled();
    transaction.resolve();
    await batchPromise;
    expect(harness.mongoClient.close).not.toHaveBeenCalled();
  } finally {
    jest.useRealTimers();
  }
});

test("does not close MongoDB with no tracked work until the timed-out runner settles", async () => {
  jest.useFakeTimers();
  try {
    const runnerDrain = createDeferred();
    const harness = createHarness({
      startupConfig: createShortShutdownConfig(),
      runnerStop: jest.fn(() => runnerDrain.promise),
    });
    await harness.startup.start();

    const stopPromise = harness.startup.stop();
    const firstStop = stopPromise.then(
      () => null,
      (error) => error,
    );
    const repeatedStop = harness.startup.stop();
    expect(repeatedStop).toBe(stopPromise);
    await jest.advanceTimersByTimeAsync(7000);
    expect((await firstStop).message)
      .toBe("V2 history shutdown cleanup failed: history runner stop.");
    expect(harness.mongoClient.close).not.toHaveBeenCalled();
    expect(harness.consumer.disconnect).not.toHaveBeenCalled();

    runnerDrain.resolve();
    await harness.mongoCloseStarted;
    await harness.consumerDisconnectStarted;

    expect(harness.runner.stop).toHaveBeenCalledTimes(1);
    expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test("closes MongoDB only after the runner drains before the shutdown deadline", async () => {
  const transaction = createDeferred();
  let batchPromise;
  let persistencePending = false;
  const closeWhilePersistencePending = [];
  const harness = createHarness({
    persistHistoryBatchImpl: jest.fn(() => {
      persistencePending = true;
      return transaction.promise.finally(() => {
        persistencePending = false;
      });
    }),
    runnerStop: jest.fn(async () => {
      if (batchPromise) await batchPromise;
    }),
    onMongoClose: () => closeWhilePersistencePending.push(persistencePending),
  });

  await harness.startup.start();
  batchPromise = harness.createRunner.mock.calls[0][0]
    .persistBatch([{ event: "pending-persistence" }]);
  const stopping = harness.startup.stop();
  transaction.resolve();

  await expect(stopping).resolves.toBeUndefined();
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
  expect(closeWhilePersistencePending).toEqual([false]);
});

test("resumes cleanup once when the runner drains after a shutdown timeout", async () => {
  jest.useFakeTimers();
  try {
    const transaction = createDeferred();
    const runnerDrain = createDeferred();
    let batchPromise;
    let persistencePending = false;
    const closeWhilePersistencePending = [];
    const harness = createHarness({
      startupConfig: createShortShutdownConfig(),
      persistHistoryBatchImpl: jest.fn(() => {
        persistencePending = true;
        return transaction.promise.finally(() => {
          persistencePending = false;
        });
      }),
      runnerStop: jest.fn(() => runnerDrain.promise),
      onMongoClose: () => closeWhilePersistencePending.push(persistencePending),
    });

    await harness.startup.start();
    batchPromise = harness.createRunner.mock.calls[0][0]
      .persistBatch([{ event: "pending-persistence" }]);
    const stopping = harness.startup.stop().then(
      () => null,
      (error) => error,
    );
    await jest.advanceTimersByTimeAsync(7000);
    const shutdownError = await stopping;
    expect(shutdownError.message)
      .toBe("V2 history shutdown cleanup failed: history runner stop.");
    expect(harness.mongoClient.close).not.toHaveBeenCalled();

    transaction.resolve();
    await batchPromise;
    expect(harness.mongoClient.close).not.toHaveBeenCalled();
    runnerDrain.resolve();
    await harness.mongoCloseStarted;
    await harness.consumerDisconnectStarted;

    expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
    expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
    expect(closeWhilePersistencePending).toEqual([false]);
  } finally {
    jest.useRealTimers();
  }
});

test("continues cleanup safely when the runner rejects after a shutdown timeout", async () => {
  jest.useFakeTimers();
  try {
    const transaction = createDeferred();
    const runnerDrain = createDeferred();
    let batchPromise;
    const harness = createHarness({
      startupConfig: createShortShutdownConfig(),
      persistHistoryBatchImpl: jest.fn(() => transaction.promise),
      runnerStop: jest.fn(() => runnerDrain.promise),
    });

    await harness.startup.start();
    batchPromise = harness.createRunner.mock.calls[0][0]
      .persistBatch([{ event: "pending-persistence" }]);
    harness.resolveTerminal({
      classification: "malformed-json",
      topic: HISTORY_TOPIC,
      partition: 3,
      offset: "29",
    });
    const terminalCleanup = harness.startup.waitForTerminalCleanup();
    const stopping = harness.startup.stop().then(
      () => null,
      (error) => error,
    );
    await jest.advanceTimersByTimeAsync(7000);
    expect((await stopping).message)
      .toBe("V2 history shutdown cleanup failed: history runner stop.");
    expect(harness.mongoClient.close).not.toHaveBeenCalled();

    transaction.reject(new Error("private persistence failure"));
    await batchPromise.then(
      () => undefined,
      () => undefined,
    );
    expect(harness.mongoClient.close).not.toHaveBeenCalled();
    runnerDrain.reject(new Error("private runner failure"));
    await harness.mongoCloseStarted;
    await harness.consumerDisconnectStarted;
    const cleanupResult = await terminalCleanup;

    expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
    expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
    expect(cleanupResult.cleanupFailure).toBeTruthy();
    expect(JSON.stringify(cleanupResult)).not.toContain("private");
  } finally {
    jest.useRealTimers();
  }
});

test("waits for a timed-out MongoDB startup operation before closing the client", async () => {
  jest.useFakeTimers();
  try {
    const mongoConnect = createDeferred();
    const harness = createHarness({
      startupConfig: createShortShutdownConfig(),
      connectMongo: jest.fn(() => mongoConnect.promise),
    });
    const starting = harness.startup.start().then(
      () => null,
      (error) => error,
    );

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(7000);
    const startupError = await starting;
    expect(startupError.message).toBe(
      "V2 history startup failed during MongoDB connection. Cleanup failed: MongoDB operations.",
    );
    expect(harness.mongoClient.close).not.toHaveBeenCalled();
    mongoConnect.resolve();

    await harness.mongoCloseStarted;
    expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
    expect(harness.events.indexOf("mongo.close"))
      .toBeGreaterThan(harness.events.indexOf("mongo.connect"));
  } finally {
    jest.useRealTimers();
  }
});

test("observes MongoDB startup rejection after its wrapper times out", async () => {
  jest.useFakeTimers();
  try {
    const mongoConnect = createDeferred();
    const harness = createHarness({
      startupConfig: createShortShutdownConfig(),
      connectMongo: jest.fn(() => mongoConnect.promise),
    });
    const starting = harness.startup.start().then(
      () => null,
      (error) => error,
    );

    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(7000);
    const startupError = await starting;
    expect(startupError.message).toBe(
      "V2 history startup failed during MongoDB connection. Cleanup failed: MongoDB operations.",
    );
    expect(harness.mongoClient.close).not.toHaveBeenCalled();
    mongoConnect.reject(new Error("mongodb://private/late failure"));

    await harness.mongoCloseStarted;
    expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
    expect(harness.events).not.toContain("mongodb://private/late failure");
  } finally {
    jest.useRealTimers();
  }
});

test("terminal failure followed by shutdown drains and cleans up only once", async () => {
  const transaction = createDeferred();
  let batchPromise;
  const harness = createHarness({
    persistHistoryBatchImpl: jest.fn(() => transaction.promise),
    runnerStop: jest.fn(async () => {
      if (batchPromise) await batchPromise;
    }),
  });
  await harness.startup.start();
  batchPromise = harness.createRunner.mock.calls[0][0]
    .persistBatch([{ event: "pending-persistence" }]);

  harness.resolveTerminal({
    classification: "malformed-json",
    topic: HISTORY_TOPIC,
    partition: 1,
    offset: "18",
  });
  const terminalCleanup = harness.startup.waitForTerminalCleanup();
  const explicitStop = harness.startup.stop();
  transaction.resolve();

  await expect(explicitStop).resolves.toBeUndefined();
  await expect(terminalCleanup).resolves.toMatchObject({
    failure: { classification: "malformed-json", partition: 1, offset: "18" },
  });
  expect(harness.runner.stop).toHaveBeenCalledTimes(1);
  expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("runs smoke preflights in order, rechecks the group twice, and blocks consumption", async () => {
  const harness = createHarness({ startupConfig: smokeConfig });

  await expect(harness.startup.start()).rejects.toThrow(
    "V2 history smoke execution is unavailable until bounded runner controls are installed.",
  );

  expect(harness.events.slice(0, 12)).toEqual([
    "kafka.admin.connect",
    "mongo.connect",
    "kafka.describeCluster",
    "kafka.fetchTopicMetadata",
    "mongo.db:admin",
    "mongo.hello",
    "mongo.replSetGetStatus",
    "smoke.topic.verify",
    "smoke.group.verify:1",
    "ownership.verify",
    "ownership.indexes.verify",
    "smoke.group.verify:2",
  ]);
  expect(harness.events.slice(12).sort()).toEqual([
    "kafka.admin.disconnect",
    "mongo.close",
  ].sort());
  expect(harness.verifyHistorySmokeTopicIdentity).toHaveBeenCalledWith({
    config: smokeConfig,
    executeCommand: harness.executeHistorySmokeCommand,
  });
  expect(harness.verifyHistorySmokeGroup).toHaveBeenCalledTimes(2);
  expect(harness.events.indexOf("smoke.topic.verify"))
    .toBeLessThan(harness.events.indexOf("smoke.group.verify:1"));
  expect(harness.events.indexOf("smoke.group.verify:1"))
    .toBeLessThan(harness.events.indexOf("ownership.verify"));
  expect(harness.events.indexOf("ownership.indexes.verify"))
    .toBeLessThan(harness.events.indexOf("smoke.group.verify:2"));
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.consumer.connect).not.toHaveBeenCalled();
  expect(harness.consumer.subscribe).not.toHaveBeenCalled();
});

test("fails closed when the smoke topic verifier is missing", () => {
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyHistorySmokeTopicIdentity: null,
  });

  expect(harness.startupError.message)
    .toBe("Invalid V2 history smoke preflight dependency.");
  expect(harness.admin.connect).not.toHaveBeenCalled();
  expect(harness.mongoClient.connect).not.toHaveBeenCalled();
});

test("fails closed when the smoke group verifier is missing", () => {
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyHistorySmokeGroup: null,
  });

  expect(harness.startupError.message)
    .toBe("Invalid V2 history smoke preflight dependency.");
  expect(harness.admin.connect).not.toHaveBeenCalled();
  expect(harness.mongoClient.connect).not.toHaveBeenCalled();
});

test("topic-ID mismatch prevents group checks, ownership, and consumer construction", async () => {
  const verifyHistorySmokeTopicIdentity = jest.fn().mockRejectedValue(
    new Error("topicId=private mismatch"),
  );
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyHistorySmokeTopicIdentity,
  });

  await expect(harness.startup.start()).rejects.toThrow(
    "V2 history startup failed during V2 history smoke topic-ID preflight.",
  );
  expect(harness.verifyHistorySmokeGroup).not.toHaveBeenCalled();
  expect(harness.verifyOwnership).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.consumer.connect).not.toHaveBeenCalled();
});

test.each([
  ["committed offsets", "committed offset payload=private"],
  ["active group members", "active member clientId=private"],
])("%s prevent smoke startup from reaching ownership or consumer creation", async (
  _label,
  privateError,
) => {
  const verifyHistorySmokeGroup = jest.fn().mockRejectedValue(
    new Error(privateError),
  );
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyHistorySmokeGroup,
  });

  const failure = await harness.startup.start().catch((error) => error);
  expect(failure.message)
    .toBe("V2 history startup failed during V2 history smoke consumer-group preflight.");
  expect(failure.message).not.toContain("private");
  expect(harness.verifyOwnership).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.consumer.connect).not.toHaveBeenCalled();
});

test("missing history TTL rejects smoke startup without index setup", async () => {
  const verifyOwnership = jest.fn(async () => ({
    databaseName: HISTORY_DATABASE_NAME,
    status: "verified",
    collections: {
      history: HISTORY_COLLECTION_NAMES.history,
      receipts: HISTORY_COLLECTION_NAMES.receipts,
    },
    indexes: {
      historyTtl: "pending-setup",
      receiptsTtl: "absent",
    },
  }));
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyOwnership,
  });

  await expect(harness.startup.start()).rejects.toThrow(
    "V2 history startup failed during V2 history smoke index verification.",
  );
  expect(harness.verifyHistorySmokeGroup).toHaveBeenCalledTimes(1);
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.consumer.connect).not.toHaveBeenCalled();
});

test("a failed final group recheck prevents smoke execution and consumer creation", async () => {
  const verifyHistorySmokeGroup = jest.fn()
    .mockResolvedValueOnce(smokeGroupResult)
    .mockRejectedValueOnce(new Error("offset=private"));
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyHistorySmokeGroup,
  });

  await expect(harness.startup.start()).rejects.toThrow(
    "V2 history startup failed during V2 history smoke consumer-group recheck.",
  );
  expect(verifyHistorySmokeGroup).toHaveBeenCalledTimes(2);
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.consumer.connect).not.toHaveBeenCalled();
});

test("shutdown during a pending smoke preflight drains it before cleanup", async () => {
  let releaseGroup;
  let notifyGroup;
  const groupStarted = new Promise((resolve) => {
    notifyGroup = resolve;
  });
  const verifyHistorySmokeGroup = jest.fn(() => {
    notifyGroup();
    return new Promise((resolve) => {
      releaseGroup = resolve;
    });
  });
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyHistorySmokeGroup,
  });

  const starting = harness.startup.start();
  await groupStarted;
  const stopping = harness.startup.stop();
  await Promise.resolve();
  expect(harness.mongoClient.close).not.toHaveBeenCalled();

  releaseGroup(smokeGroupResult);
  await expect(starting).rejects.toThrow("V2 history startup cancelled.");
  await expect(stopping).resolves.toBeUndefined();
  expect(harness.verifyHistorySmokeGroup).toHaveBeenCalledTimes(1);
  expect(harness.verifyOwnership).not.toHaveBeenCalled();
  expect(harness.ensureIndexes).not.toHaveBeenCalled();
  expect(harness.createConsumer).not.toHaveBeenCalled();
  expect(harness.consumer.connect).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
});

test("smoke preflight cleanup is idempotent and does not expose verifier errors", async () => {
  const verifyHistorySmokeTopicIdentity = jest.fn().mockRejectedValue(
    new Error("mongodb://private/credentials"),
  );
  const harness = createHarness({
    startupConfig: smokeConfig,
    verifyHistorySmokeTopicIdentity,
  });

  const failure = await harness.startup.start().catch((error) => error);
  expect(failure.message)
    .toBe("V2 history startup failed during V2 history smoke topic-ID preflight.");
  expect(failure.message).not.toContain("private");

  const firstStop = harness.startup.stop();
  const secondStop = harness.startup.stop();
  expect(secondStop).toBe(firstStop);
  await expect(firstStop).resolves.toBeUndefined();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.mongoClient.close).toHaveBeenCalledTimes(1);
  expect(harness.createConsumer).not.toHaveBeenCalled();
});
