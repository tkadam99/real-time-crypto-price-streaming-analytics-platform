const { EventEmitter } = require("events");
const {
  HISTORY_CONSUMER_GROUP_ID,
  HISTORY_DATABASE_NAME,
  HISTORY_KAFKA_BROKER,
  HISTORY_MONGO_URI,
  HISTORY_TOPIC,
  LIVE_START_ACKNOWLEDGEMENT,
} = require("../v2/historyConsumerConfig");
const { HISTORY_COLLECTION_NAMES } = require("../v2/historyCollectionInspection");
const {
  createHistoryConsumerApplication,
  runHistoryConsumer,
} = require("../v2/historyConsumerMain");

const enabledEnv = {
  V2_HISTORY_CONSUMER_ENABLED: "true",
  V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
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

function createHarness({
  env = enabledEnv,
  startupStart,
  startupStop = jest.fn(async () => {}),
  waitForTerminalCleanup = jest.fn(() => new Promise(() => {})),
  onFailure,
  KafkaConstructor,
  MongoClientConstructor,
  startupFactory,
  getTerminalFailure = jest.fn(() => null),
} = {}) {
  const events = [];
  const kafkaOptions = [];
  const consumerOptions = [];
  const databaseNames = [];
  const collectionNames = [];
  const processObject = new EventEmitter();
  const addProcessListener = processObject.on.bind(processObject);
  processObject.on = jest.fn((signal, listener) => {
    events.push(`process.on:${signal}`);
    return addProcessListener(signal, listener);
  });
  processObject.exit = jest.fn();
  const logger = { error: jest.fn() };
  const admin = {
    connect: jest.fn(),
    disconnect: jest.fn(),
  };
  const consumer = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    stop: jest.fn(),
    subscribe: jest.fn(),
    run: jest.fn(),
    commitOffsets: jest.fn(),
    seek: jest.fn(),
    pause: jest.fn(),
  };
  const database = {
    databaseName: HISTORY_DATABASE_NAME,
    client: null,
    createCollection: jest.fn(),
    dropCollection: jest.fn(),
    dropDatabase: jest.fn(),
  };
  const historyCollection = {
    collectionName: HISTORY_COLLECTION_NAMES.history,
    db: database,
    listIndexes: jest.fn(),
    createIndex: jest.fn(),
    insertOne: jest.fn(),
  };
  const receiptCollection = {
    collectionName: HISTORY_COLLECTION_NAMES.receipts,
    db: database,
    listIndexes: jest.fn(),
    createIndex: jest.fn(),
    findOne: jest.fn(),
    insertOne: jest.fn(),
  };
  database.collection = jest.fn((name) => {
    events.push(`database.collection:${name}`);
    collectionNames.push(name);
    if (name === HISTORY_COLLECTION_NAMES.history) return historyCollection;
    if (name === HISTORY_COLLECTION_NAMES.receipts) return receiptCollection;
    throw new Error("unapproved collection name");
  });
  const mongoClient = {
    connect: jest.fn(async () => { events.push("mongo.connect"); }),
    close: jest.fn(async () => { events.push("mongo.close"); }),
    db: jest.fn((name) => {
      events.push(`mongo.db:${name}`);
      databaseNames.push(name);
      if (name !== HISTORY_DATABASE_NAME) throw new Error("unapproved database name");
      return database;
    }),
  };
  database.client = mongoClient;

  const kafka = {
    admin: jest.fn(() => {
      events.push("kafka.admin");
      return admin;
    }),
    consumer: jest.fn((options) => {
      events.push("kafka.consumer");
      consumerOptions.push(options);
      return consumer;
    }),
  };
  const KafkaCtor = KafkaConstructor || jest.fn(function (options) {
    events.push("kafka.construct");
    kafkaOptions.push(options);
    return kafka;
  });
  const MongoClientCtor = MongoClientConstructor || jest.fn(function (uri, options) {
    events.push("mongo.construct");
    this.uri = uri;
    this.options = options;
    return mongoClient;
  });

  let startupOptions;
  let notifyStartupStarted;
  const startupStarted = new Promise((resolve) => {
    notifyStartupStarted = resolve;
  });
  const defaultStartupStart = jest.fn(async () => {
    events.push("startup.start");
    notifyStartupStarted();
  });
  const startup = {
    start: startupStart || defaultStartupStart,
    stop: startupStop,
    waitForTerminalCleanup,
    getTerminalFailure,
  };
  const createStartup = startupFactory || jest.fn((options) => {
    events.push("startup.create");
    startupOptions = options;
    return startup;
  });
  const captureStartupFactory = (options) => {
    startupOptions = options;
    return createStartup(options);
  };
  const dependencies = {
    env,
    KafkaConstructor: KafkaCtor,
    MongoClientConstructor: MongoClientCtor,
    createStartup: captureStartupFactory,
    processObject,
    logger,
    onFailure,
  };

  return {
    admin,
    collectionNames,
    consumer,
    consumerOptions,
    createStartup,
    database,
    databaseNames,
    dependencies,
    events,
    historyCollection,
    kafka,
    kafkaOptions,
    logger,
    mongoClient,
    MongoClientConstructor: MongoClientCtor,
    processObject,
    receiptCollection,
    startup,
    startupStarted,
    startupOptions: () => startupOptions,
    KafkaConstructor: KafkaCtor,
  };
}

test.each([
  ["missing enablement", {}],
  ["missing acknowledgement", {
    V2_HISTORY_CONSUMER_ENABLED: "true",
  }],
  ["incorrect acknowledgement", {
    ...enabledEnv,
    V2_HISTORY_LIVE_START_ACK: "I_ACKNOWLEDGE_SOMETHING_ELSE",
  }],
])("%s fails before constructing clients", (_label, env) => {
  const KafkaConstructor = jest.fn();
  const MongoClientConstructor = jest.fn();

  expect(() => createHistoryConsumerApplication({
    env,
    KafkaConstructor,
    MongoClientConstructor,
  })).toThrow();
  expect(KafkaConstructor).not.toHaveBeenCalled();
  expect(MongoClientConstructor).not.toHaveBeenCalled();
});

test("constructs only pinned V2 clients and passes approved handles to the supervisor", () => {
  const harness = createHarness();
  const app = createHistoryConsumerApplication(harness.dependencies);
  const config = app.config;

  expect(harness.kafkaOptions).toEqual([{
    clientId: "crypto-v2-history-consumer",
    brokers: [HISTORY_KAFKA_BROKER],
    connectionTimeout: config.kafka.options.connectionTimeout,
    requestTimeout: config.kafka.options.requestTimeout,
  }]);
  expect(harness.MongoClientConstructor).toHaveBeenCalledWith(
    HISTORY_MONGO_URI,
    config.mongo.options,
  );
  expect(harness.databaseNames).toEqual([HISTORY_DATABASE_NAME]);
  expect(harness.collectionNames).toEqual([
    HISTORY_COLLECTION_NAMES.history,
    HISTORY_COLLECTION_NAMES.receipts,
  ]);
  expect(harness.createStartup).toHaveBeenCalledWith(expect.objectContaining({
    config,
    admin: harness.admin,
    mongoClient: harness.mongoClient,
    historyCollection: harness.historyCollection,
    receiptCollection: harness.receiptCollection,
    onFailure: expect.any(Function),
    createConsumer: expect.any(Function),
  }));
  expect(harness.kafka.consumer).not.toHaveBeenCalled();
  expect(harness.mongoClient.connect).not.toHaveBeenCalled();
  expect(harness.admin.connect).not.toHaveBeenCalled();
  expect(harness.database.createCollection).not.toHaveBeenCalled();
  expect(harness.historyCollection.createIndex).not.toHaveBeenCalled();
  expect(harness.receiptCollection.createIndex).not.toHaveBeenCalled();
});

test("creates the Kafka consumer lazily with the dedicated group and bounded settings", () => {
  const harness = createHarness();
  const app = createHistoryConsumerApplication(harness.dependencies);
  const config = app.config;

  const createdConsumer = harness.startupOptions().createConsumer();

  expect(createdConsumer).toBe(harness.consumer);
  expect(harness.kafka.consumer).toHaveBeenCalledTimes(1);
  expect(harness.consumerOptions).toEqual([{
    groupId: HISTORY_CONSUMER_GROUP_ID,
    sessionTimeout: config.consumer.sessionTimeoutMs,
    heartbeatInterval: config.consumer.heartbeatIntervalMs,
    allowAutoTopicCreation: false,
  }]);
  expect(harness.consumerOptions[0].groupId).toBe("crypto-v2-history-group");
  expect(harness.consumerOptions[0]).not.toHaveProperty("fromBeginning");
  expect(harness.consumerOptions[0]).not.toHaveProperty("autoCommit");
  expect(harness.consumer.seek).not.toHaveBeenCalled();
  expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
});

test("installs no startup side effects when the module is imported", () => {
  const KafkaConstructor = jest.fn();
  const MongoClientConstructor = jest.fn();
  const createStartup = jest.fn();
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");

  try {
    jest.isolateModules(() => {
      jest.doMock("kafkajs", () => ({ Kafka: KafkaConstructor }));
      jest.doMock("mongodb", () => ({ MongoClient: MongoClientConstructor }));
      jest.doMock("../v2/historyConsumerStartup", () => ({
        createHistoryConsumerStartup: createStartup,
      }));

      const imported = require("../v2/historyConsumerMain");
      expect(imported.createHistoryConsumerApplication).toEqual(expect.any(Function));
      expect(imported.main).toEqual(expect.any(Function));
      expect(KafkaConstructor).not.toHaveBeenCalled();
      expect(MongoClientConstructor).not.toHaveBeenCalled();
      expect(createStartup).not.toHaveBeenCalled();
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    });
  } finally {
    jest.dontMock("kafkajs");
    jest.dontMock("mongodb");
    jest.dontMock("../v2/historyConsumerStartup");
  }
});

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
])("%s waits for supervisor cleanup before returning", async (signal, exitCode) => {
  let releaseStop;
  let notifyStop;
  const stopStarted = new Promise((resolve) => {
    notifyStop = resolve;
  });
  const stopPending = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const harness = createHarness({
    startupStop: jest.fn(() => {
      notifyStop();
      return stopPending;
    }),
  });

  const running = runHistoryConsumer(harness.dependencies);
  await harness.startupStarted;
  await Promise.resolve();
  expect(harness.events.indexOf("process.on:SIGINT"))
    .toBeLessThan(harness.events.indexOf("startup.start"));
  expect(harness.events.indexOf("process.on:SIGTERM"))
    .toBeLessThan(harness.events.indexOf("startup.start"));
  harness.processObject.emit(signal);
  await stopStarted;
  releaseStop();

  const application = await running;
  expect(application).toBeDefined();
  expect(harness.startup.stop).toHaveBeenCalledTimes(1);
  expect(harness.processObject.exitCode).toBe(exitCode);
  expect(harness.processObject.listenerCount("SIGINT")).toBe(0);
  expect(harness.processObject.listenerCount("SIGTERM")).toBe(0);
  expect(harness.processObject.exit).not.toHaveBeenCalled();
});

test("repeated signals share one supervisor cleanup operation", async () => {
  const stopPending = createDeferred();
  let notifyStop;
  const stopStarted = new Promise((resolve) => {
    notifyStop = resolve;
  });
  const harness = createHarness({
    startupStop: jest.fn(() => {
      notifyStop();
      return stopPending.promise;
    }),
  });
  const running = runHistoryConsumer(harness.dependencies);

  await harness.startupStarted;
  harness.processObject.emit("SIGINT");
  await stopStarted;
  harness.processObject.emit("SIGTERM");
  harness.processObject.emit("SIGINT");
  stopPending.resolve();

  await running;
  expect(harness.startup.stop).toHaveBeenCalledTimes(1);
  expect(harness.processObject.exitCode).toBe(130);
  expect(harness.processObject.exit).not.toHaveBeenCalled();
});

test.each([
  ["SIGINT", 130],
  ["SIGTERM", 143],
])("%s during pending startup cancels safely without duplicate cleanup", async (signal, exitCode) => {
  let rejectStart;
  let notifyStart;
  const startStarted = new Promise((resolve) => {
    notifyStart = resolve;
  });
  const startupStart = jest.fn(() => new Promise((_resolve, reject) => {
    rejectStart = reject;
    notifyStart();
  }));
  const startupStop = jest.fn(async () => {
    rejectStart(new Error("private startup failure"));
  });
  const harness = createHarness({ startupStart, startupStop });

  const running = runHistoryConsumer(harness.dependencies);
  await startStarted;
  harness.processObject.emit(signal);

  const application = await running;
  expect(application).toBeDefined();
  expect(harness.startup.stop).toHaveBeenCalledTimes(1);
  expect(harness.kafka.consumer).not.toHaveBeenCalled();
  expect(harness.processObject.exitCode).toBe(exitCode);
  expect(harness.processObject.exit).not.toHaveBeenCalled();
});

test("incomplete signal cleanup logs a sanitized failure and sets exit code 1", async () => {
  const harness = createHarness({
    startupStop: jest.fn().mockRejectedValue(
      new Error("mongodb://private-user:private-password/secret"),
    ),
  });
  const running = runHistoryConsumer(harness.dependencies);

  await harness.startupStarted;
  harness.processObject.emit("SIGTERM");
  await running;

  expect(harness.processObject.exitCode).toBe(1);
  expect(harness.logger.error).toHaveBeenCalledWith(
    "V2 history consumer shutdown failed.",
  );
  expect(harness.logger.error.mock.calls.flat().join(" "))
    .not.toMatch(/mongodb:\/\/|private-password|secret/);
  expect(harness.processObject.exit).not.toHaveBeenCalled();
});

test("terminal runner failure remains a failure when followed by a graceful signal", async () => {
  let terminalFailure = null;
  const harness = createHarness({
    getTerminalFailure: () => terminalFailure,
  });
  const running = runHistoryConsumer(harness.dependencies);

  await harness.startupStarted;
  await Promise.resolve();
  terminalFailure = {
    classification: "malformed-json",
    topic: HISTORY_TOPIC,
    partition: 2,
    offset: "17",
  };
  harness.processObject.emit("SIGINT");

  await running;
  expect(harness.processObject.exitCode).toBe(1);
  expect(harness.processObject.exit).not.toHaveBeenCalled();
});

test("late deferred cleanup success never resets an incomplete-shutdown exit code", async () => {
  const lateCleanup = createDeferred();
  const harness = createHarness({
    waitForTerminalCleanup: jest.fn(() => lateCleanup.promise),
    startupStop: jest.fn().mockRejectedValue(
      new Error("private driver timeout"),
    ),
  });
  const running = runHistoryConsumer(harness.dependencies);

  await harness.startupStarted;
  await Promise.resolve();
  harness.processObject.emit("SIGINT");
  await running;
  expect(harness.processObject.exitCode).toBe(1);

  lateCleanup.resolve({ failure: null, cleanupFailure: null });
  await lateCleanup.promise;
  expect(harness.processObject.exitCode).toBe(1);
  expect(harness.processObject.exit).not.toHaveBeenCalled();
});

test("observes rejected signal cleanup without unhandled rejections", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const lateCleanup = createDeferred();
    const harness = createHarness({
      waitForTerminalCleanup: jest.fn(() => lateCleanup.promise),
      startupStop: jest.fn().mockRejectedValue(
        new Error("mongodb://private/shutdown timeout"),
      ),
    });
    const running = runHistoryConsumer(harness.dependencies);
    await harness.startupStarted;
    await Promise.resolve();
    harness.processObject.emit("SIGTERM");
    await running;
    lateCleanup.reject(new Error("mongodb://private/late cleanup failure"));
    await new Promise((resolve) => setImmediate(resolve));

    expect(unhandled).toEqual([]);
    expect(harness.processObject.exitCode).toBe(1);
    expect(harness.processObject.exit).not.toHaveBeenCalled();
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});

test("terminal runner failure awaits cleanup and sets a nonzero exit code", async () => {
  const failure = {
    classification: "malformed-json",
    topic: "untrusted-topic",
    partition: 2,
    offset: "17",
    payload: "must-not-be-logged",
    error: "mongodb://private/credentials",
  };
  let startupOptions;
  const stop = jest.fn(async () => {});
  const waitForTerminalCleanup = jest.fn(async () => {
    await startupOptions.onFailure(failure);
    await stop();
    return { failure, cleanupFailure: null };
  });
  const createStartup = jest.fn((options) => {
    startupOptions = options;
    return {
      start: jest.fn(async () => {}),
      stop,
      waitForTerminalCleanup,
    };
  });
  const harness = createHarness({ startupFactory: createStartup });

  const application = await runHistoryConsumer(harness.dependencies);

  expect(application).toBeDefined();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(harness.processObject.exitCode).toBe(1);
  expect(harness.logger.error).toHaveBeenCalledTimes(1);
  const logged = harness.logger.error.mock.calls[0][0];
  expect(logged).toContain("classification=malformed-json");
  expect(logged).toContain(`topic=${HISTORY_TOPIC}`);
  expect(logged).toContain("partition=2");
  expect(logged).toContain("offset=17");
  expect(logged).not.toContain("must-not-be-logged");
  expect(logged).not.toContain("mongodb://");
  expect(logged).not.toContain("untrusted-topic");
});

test("sanitizes construction and startup errors", async () => {
  const logger = { error: jest.fn() };
  const processObject = new EventEmitter();
  const KafkaConstructor = jest.fn(() => {
    throw new Error("mongodb://user:password@host/secret");
  });
  const setupResult = await runHistoryConsumer({
    env: enabledEnv,
    KafkaConstructor,
    MongoClientConstructor: jest.fn(),
    processObject,
    logger,
  });

  expect(setupResult).toBeNull();
  expect(processObject.exitCode).toBe(1);
  expect(logger.error).toHaveBeenCalledWith(
    "V2 history configuration or client setup failed.",
  );
  expect(logger.error.mock.calls.flat().join(" "))
    .not.toContain("password");

  const harness = createHarness({
    startupStart: jest.fn().mockRejectedValue(
      new Error("credential=secret payload and connection string"),
    ),
  });
  const startupResult = await runHistoryConsumer(harness.dependencies);

  expect(startupResult).toBeNull();
  expect(harness.processObject.exitCode).toBe(1);
  expect(harness.logger.error).toHaveBeenCalledWith(
    "V2 history consumer startup failed.",
  );
  expect(harness.logger.error.mock.calls.flat().join(" "))
    .not.toContain("credential=secret");
});

test("repeated application shutdown calls share one supervisor cleanup", async () => {
  const harness = createHarness();
  const application = createHistoryConsumerApplication(harness.dependencies);
  await application.start();

  const firstStop = application.stop();
  const secondStop = application.stop();

  expect(secondStop).toBe(firstStop);
  await Promise.all([firstStop, secondStop]);
  expect(harness.startup.stop).toHaveBeenCalledTimes(1);
  application.installSignalHandlers().remove();
});
