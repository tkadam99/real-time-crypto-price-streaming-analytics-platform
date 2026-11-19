const {
  HISTORY_CONSUMER_GROUP_ID,
  HISTORY_DATABASE_NAME,
  HISTORY_KAFKA_BROKER,
  HISTORY_KAFKA_CLUSTER_ID,
  HISTORY_MONGO_MEMBER,
  HISTORY_MONGO_URI,
  HISTORY_REPLICA_SET_NAME,
  HISTORY_TOPIC,
} = require("./historyConsumerConfig");
const { verifyHistoryConsumerPreflights } = require("./historyConsumerPreflight");
const { createHistoryConsumerRunner } = require("./historyConsumerRunner");
const { persistHistoryBatch } = require("./historyBatch");
const { ensureHistoryIndexes } = require("./historyIndexes");

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "SyntaxError",
  "TypeError",
  "RangeError",
  "ReferenceError",
]);
const RUNNER_FAILURE_CLASSIFICATIONS = new Set([
  "invalid-kafka-partition",
  "invalid-kafka-offset",
  "non-increasing-kafka-offset",
  "next-kafka-offset-out-of-range",
  "malformed-json",
  "invalid-envelope",
  "invalid-event-routing",
  "partition-routing-violation",
  "persistence-batch-failed",
  "invalid-persistence-batch-result",
  "persistence-failed",
  "missing-persistence-identity",
  "persistence-identity-mismatch",
  "unexpected-kafka-batch",
  "invalid-kafka-batch-context",
  "heartbeat-failed",
  "heartbeat-timeout",
  "history-processing-failed",
  "invalid-history-processing-result",
  "offset-commit-failed",
  "kafka-consumer-run-failed",
]);

function isBoundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validateConfig(config) {
  if (!config || config.enabled !== true ||
      config.liveStartAcknowledged !== true ||
      !config.kafka || !config.consumer || !config.mongo || !config.history ||
      config.kafka.broker !== HISTORY_KAFKA_BROKER ||
      config.kafka.clusterId !== HISTORY_KAFKA_CLUSTER_ID ||
      config.kafka.topic !== HISTORY_TOPIC ||
      config.kafka.topicPartitionCount !== 6 ||
      config.consumer.groupId !== HISTORY_CONSUMER_GROUP_ID ||
      config.mongo.uri !== HISTORY_MONGO_URI ||
      config.mongo.databaseName !== HISTORY_DATABASE_NAME ||
      config.mongo.replicaSetName !== HISTORY_REPLICA_SET_NAME ||
      config.mongo.member !== HISTORY_MONGO_MEMBER) {
    throw new Error("Invalid or disabled pinned V2 history startup configuration.");
  }

  const mongoOptions = config.mongo.options;
  const kafkaOptions = config.kafka.options;
  if (!mongoOptions ||
      !isBoundedInteger(mongoOptions.timeoutMS, 1000, 60000) ||
      !isBoundedInteger(mongoOptions.connectTimeoutMS, 250, 30000) ||
      !isBoundedInteger(mongoOptions.serverSelectionTimeoutMS, 250, 30000) ||
      !isBoundedInteger(mongoOptions.socketTimeoutMS, 250, 60000) ||
      !kafkaOptions ||
      !isBoundedInteger(kafkaOptions.connectionTimeout, 250, 30000) ||
      !isBoundedInteger(kafkaOptions.requestTimeout, 250, 30000) ||
      !isBoundedInteger(config.consumer.sessionTimeoutMs, 6000, 120000) ||
      !isBoundedInteger(config.consumer.heartbeatIntervalMs, 100, 30000) ||
      !isBoundedInteger(config.consumer.heartbeatTimeoutMs, 10, 30000) ||
      config.consumer.heartbeatIntervalMs >= config.consumer.sessionTimeoutMs ||
      config.consumer.heartbeatTimeoutMs >= config.consumer.sessionTimeoutMs ||
      !isBoundedInteger(config.consumer.partitionsConsumedConcurrently, 1, 2) ||
      !isBoundedInteger(config.history.batchSize, 1, 100) ||
      !isBoundedInteger(config.history.concurrency, 1, 4)) {
    throw new Error("Invalid or unbounded V2 history startup settings.");
  }
}

function validateDependencies({
  config,
  admin,
  mongoClient,
  historyCollection,
  receiptCollection,
  createConsumer,
  ensureIndexes,
  verifyPreflights,
  persistHistoryBatchImpl,
  createRunner,
  onFailure,
}) {
  if (!admin || typeof admin.connect !== "function" ||
      typeof admin.disconnect !== "function") {
    throw new Error("Invalid V2 history Kafka admin dependency.");
  }
  if (!mongoClient || typeof mongoClient.connect !== "function" ||
      typeof mongoClient.db !== "function" ||
      typeof mongoClient.close !== "function") {
    throw new Error("Invalid V2 history MongoDB client dependency.");
  }
  if (!historyCollection || !receiptCollection) {
    throw new Error("V2 history collection dependencies are required.");
  }
  if (!historyCollection.db ||
      historyCollection.db.databaseName !== config.mongo.databaseName ||
      historyCollection.db.client !== mongoClient ||
      !receiptCollection.db ||
      receiptCollection.db.databaseName !== config.mongo.databaseName ||
      receiptCollection.db.client !== mongoClient) {
    throw new Error("V2 history collections must belong to the pinned V2 MongoDB client and database.");
  }
  if (typeof historyCollection.listIndexes !== "function" ||
      typeof historyCollection.createIndex !== "function" ||
      typeof historyCollection.insertOne !== "function" ||
      typeof receiptCollection.listIndexes !== "function" ||
      typeof receiptCollection.findOne !== "function" ||
      typeof receiptCollection.insertOne !== "function") {
    throw new Error("V2 history collections do not provide the required persistence operations.");
  }
  if (typeof createConsumer !== "function" ||
      typeof ensureIndexes !== "function" ||
      typeof verifyPreflights !== "function" ||
      typeof persistHistoryBatchImpl !== "function" ||
      typeof createRunner !== "function" ||
      typeof onFailure !== "function") {
    throw new Error("Invalid V2 history startup factory or failure handler.");
  }
}

function boundedCall(operation, timeoutMs, label) {
  let timer;
  const observed = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ status: "fulfilled", value }),
      () => ({ status: "rejected" }),
    );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), Math.max(0, timeoutMs));
  });

  return Promise.race([observed, timeout]).then((result) => {
    clearTimeout(timer);
    if (result.status === "timeout") throw new Error(`${label} timed out.`);
    if (result.status === "rejected") throw new Error(`${label} failed.`);
    return result.value;
  });
}

function sanitizeTerminalFailure(failure) {
  const classification = failure &&
    RUNNER_FAILURE_CLASSIFICATIONS.has(failure.classification)
    ? failure.classification
    : "history-runner-supervision-failed";
  const partition = failure && Number.isInteger(failure.partition) &&
    failure.partition >= 0 && failure.partition < 6
    ? failure.partition
    : null;
  const offset = failure && typeof failure.offset === "string" &&
    /^(0|[1-9][0-9]*)$/.test(failure.offset)
    ? failure.offset
    : null;

  return Object.freeze({
    classification,
    topic: HISTORY_TOPIC,
    partition,
    offset,
    ...(failure && SAFE_ERROR_NAMES.has(failure.errorName)
      ? { errorName: failure.errorName }
      : {}),
  });
}

function createHistoryConsumerStartup({
  config,
  admin,
  mongoClient,
  historyCollection,
  receiptCollection,
  createConsumer,
  ensureIndexes = ensureHistoryIndexes,
  verifyPreflights = verifyHistoryConsumerPreflights,
  persistHistoryBatchImpl = persistHistoryBatch,
  createRunner = createHistoryConsumerRunner,
  onFailure,
}) {
  validateConfig(config);
  validateDependencies({
    config,
    admin,
    mongoClient,
    historyCollection,
    receiptCollection,
    createConsumer,
    ensureIndexes,
    verifyPreflights,
    persistHistoryBatchImpl,
    createRunner,
    onFailure,
  });

  const startupTimeoutMs = Math.max(
    config.kafka.options.requestTimeout,
    config.mongo.options.timeoutMS,
  );
  const shutdownTimeoutMs =
    config.mongo.options.timeoutMS + config.consumer.sessionTimeoutMs;
  let startPromise;
  let stopPromise;
  let cleanupPromise;
  let adminConnectionAttempted = false;
  let mongoConnectionAttempted = false;
  let consumerConnectionAttempted = false;
  let stopRequested = false;
  let consumer;
  let runner;
  let adminDisconnectPromise;
  let mongoClosePromise;
  let consumerDisconnectPromise;
  let consumerStopPromise;
  let runnerStopPromise;
  let runnerConsumer;
  let terminalFailure = null;
  let terminalCleanupFailure = null;
  let terminalMonitorPromise;
  let resolveTerminalFailure;
  const terminalFailureSignal = new Promise((resolve) => {
    resolveTerminalFailure = resolve;
  });

  function disconnectAdmin() {
    if (!adminConnectionAttempted) return Promise.resolve();
    if (!adminDisconnectPromise) {
      adminDisconnectPromise = Promise.resolve().then(() => admin.disconnect());
    }
    return adminDisconnectPromise;
  }

  function closeMongoClient() {
    if (!mongoConnectionAttempted) return Promise.resolve();
    if (!mongoClosePromise) {
      mongoClosePromise = Promise.resolve().then(() => mongoClient.close());
    }
    return mongoClosePromise;
  }

  function disconnectConsumer() {
    if (!consumerConnectionAttempted || !consumer) return Promise.resolve();
    if (!consumerDisconnectPromise) {
      consumerDisconnectPromise = Promise.resolve().then(() => consumer.disconnect());
    }
    return consumerDisconnectPromise;
  }

  function stopConsumerOnce() {
    if (!consumer || !consumerConnectionAttempted) return Promise.resolve();
    if (!consumerStopPromise) {
      consumerStopPromise = Promise.resolve().then(() => consumer.stop());
    }
    return consumerStopPromise;
  }

  function stopRunner() {
    if (runner) {
      if (!runnerStopPromise) {
        runnerStopPromise = Promise.resolve().then(() => runner.stop());
      }
      return runnerStopPromise;
    }
    return Promise.resolve();
  }

  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures = [];
      const deadline = Date.now() + shutdownTimeoutMs;

      async function attempt(label, operation) {
        try {
          await boundedCall(operation, Math.max(0, deadline - Date.now()), label);
        } catch {
          failures.push(label);
        }
      }

      await attempt("history runner stop", stopRunner);
      await attempt("Kafka consumer stop", stopConsumerOnce);
      await attempt("Kafka consumer disconnect", disconnectConsumer);
      await attempt("Kafka admin disconnect", disconnectAdmin);
      await attempt("MongoDB client close", closeMongoClient);
      return failures;
    })();
    return cleanupPromise;
  }

  function reportSupervisionFailure() {
    if (terminalFailure) return;
    terminalFailure = sanitizeTerminalFailure({
      classification: "history-runner-supervision-failed",
    });
    resolveTerminalFailure(terminalFailure);
    try {
      Promise.resolve(onFailure(terminalFailure)).catch(() => {
        terminalCleanupFailure = "History failure notification failed.";
      });
    } catch {
      terminalCleanupFailure = "History failure notification failed.";
    }
  }

  function superviseRunnerTerminalFailure() {
    let terminalSignal;
    try {
      terminalSignal = runner.waitForTerminalFailure();
    } catch {
      reportSupervisionFailure();
      terminalMonitorPromise = Promise.resolve();
      return;
    }

    terminalMonitorPromise = Promise.resolve(terminalSignal)
      .then(async (failure) => {
        if (!failure || terminalFailure) return;
        terminalFailure = sanitizeTerminalFailure(failure);
        resolveTerminalFailure(terminalFailure);
        try {
          await stop();
        } catch {
          terminalCleanupFailure = "V2 history terminal-failure cleanup failed.";
        }
      })
      .catch(async () => {
        reportSupervisionFailure();
        try {
          await stop();
        } catch {
          terminalCleanupFailure = "V2 history terminal-failure cleanup failed.";
        }
      });
    terminalMonitorPromise.catch(() => {
      terminalCleanupFailure = "V2 history terminal-failure supervision failed.";
    });
  }

  function checkCancellation() {
    if (stopRequested) throw new Error("Startup cancelled.");
  }

  function start() {
    if (stopRequested) return Promise.reject(new Error("V2 history startup has been stopped."));
    if (startPromise) return startPromise;

    startPromise = (async () => {
      let stage = "Kafka admin connection";
      try {
        adminConnectionAttempted = true;
        await boundedCall(
          () => admin.connect(),
          config.kafka.options.connectionTimeout,
          stage,
        );
        checkCancellation();

        stage = "MongoDB connection";
        mongoConnectionAttempted = true;
        await boundedCall(
          () => mongoClient.connect(),
          config.mongo.options.timeoutMS,
          stage,
        );
        checkCancellation();

        stage = "Kafka and MongoDB identity preflight";
        await boundedCall(
          () => verifyPreflights({ admin, mongoClient, config }),
          startupTimeoutMs,
          stage,
        );
        checkCancellation();

        stage = "Kafka admin disconnect";
        await boundedCall(disconnectAdmin, config.kafka.options.requestTimeout, stage);
        checkCancellation();

        stage = "history index setup";
        await boundedCall(
          () => ensureIndexes({ historyCollection, receiptCollection }),
          config.mongo.options.timeoutMS,
          stage,
        );
        checkCancellation();

        stage = "Kafka consumer creation";
        consumer = createConsumer({
          broker: config.kafka.broker,
          connectionTimeout: config.kafka.options.connectionTimeout,
          requestTimeout: config.kafka.options.requestTimeout,
          groupId: config.consumer.groupId,
          sessionTimeout: config.consumer.sessionTimeoutMs,
          heartbeatInterval: config.consumer.heartbeatIntervalMs,
          allowAutoTopicCreation: false,
        });
        if (!consumer || typeof consumer.connect !== "function" ||
            typeof consumer.disconnect !== "function" ||
            typeof consumer.stop !== "function") {
          throw new Error("Invalid Kafka consumer.");
        }
        runnerConsumer = new Proxy(consumer, {
          get(target, property) {
            if (property === "stop") return stopConsumerOnce;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        checkCancellation();

        const persistBatch = (envelopes) => persistHistoryBatchImpl({
          client: mongoClient,
          historyCollection,
          receiptCollection,
          envelopes,
          batchSize: config.history.batchSize,
          concurrency: config.history.concurrency,
        });
        stage = "history runner creation";
        runner = createRunner({
          consumer: runnerConsumer,
          persistBatch,
          config: {
            groupId: config.consumer.groupId,
            partitionsConsumedConcurrently:
              config.consumer.partitionsConsumedConcurrently,
            heartbeatIntervalMs: config.consumer.heartbeatIntervalMs,
            heartbeatTimeoutMs: config.consumer.heartbeatTimeoutMs,
          },
          onFailure,
        });
        if (!runner || typeof runner.start !== "function" ||
            typeof runner.stop !== "function" ||
            typeof runner.waitForTerminalFailure !== "function") {
          throw new Error("Invalid V2 history consumer runner.");
        }
        checkCancellation();

        stage = "Kafka consumer connection";
        consumerConnectionAttempted = true;
        await boundedCall(
          () => consumer.connect(),
          config.kafka.options.connectionTimeout,
          stage,
        );
        checkCancellation();

        stage = "history runner startup";
        await boundedCall(() => runner.start(), config.kafka.options.requestTimeout, stage);
        checkCancellation();
        superviseRunnerTerminalFailure();
        return runner;
      } catch {
        const cleanupFailures = await cleanup();
        const details = cleanupFailures.length
          ? ` Cleanup failed: ${cleanupFailures.join(", ")}.`
          : "";
        if (stopRequested) {
          throw new Error(`V2 history startup cancelled.${details}`);
        }
        throw new Error(`V2 history startup failed during ${stage}.${details}`);
      }
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      if (startPromise) {
        try {
          await boundedCall(
            () => startPromise.catch(() => undefined),
            shutdownTimeoutMs,
            "history startup drain",
          );
        } catch {
          terminalCleanupFailure = "V2 history startup did not drain before shutdown.";
        }
      }
      const failures = await cleanup();
      if (failures.length > 0) {
        throw new Error(`V2 history shutdown cleanup failed: ${failures.join(", ")}.`);
      }
    })();
    return stopPromise;
  }

  async function waitForTerminalCleanup() {
    const failure = await terminalFailureSignal;
    if (terminalMonitorPromise) await terminalMonitorPromise;
    return {
      failure,
      cleanupFailure: terminalCleanupFailure,
    };
  }

  return {
    start,
    stop,
    getTerminalFailure: () => terminalFailure,
    waitForTerminalFailure: () => terminalFailureSignal,
    waitForTerminalCleanup,
  };
}

module.exports = {
  createHistoryConsumerStartup,
};
