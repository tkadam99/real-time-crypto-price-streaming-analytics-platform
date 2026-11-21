const { Kafka } = require("kafkajs");
const { MongoClient } = require("mongodb");
const {
  HISTORY_COLLECTION_NAMES,
} = require("./historyCollectionInspection");
const {
  loadHistoryConsumerConfig,
} = require("./historyConsumerConfig");
const { createHistoryConsumerStartup } = require("./historyConsumerStartup");

const SAFE_ERROR_NAMES = new Set([
  "Error",
  "SyntaxError",
  "TypeError",
  "RangeError",
  "ReferenceError",
]);
const SAFE_FAILURE_CLASSIFICATIONS = new Set([
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
  "history-runner-supervision-failed",
]);
const MAX_KAFKA_OFFSET = 9223372036854775807n;

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSmokeOutcome(result, allowPending) {
  if (!result || typeof result !== "object") return false;
  if (result.status === "pending") {
    return allowPending && hasExactKeys(result, ["status"]);
  }
  if (result.status === "success" || result.status === "timeout") {
    return hasExactKeys(result, ["status"]);
  }
  if (result.status === "failed") {
    return hasExactKeys(result, ["status", "reason"]) &&
      ["runner-failure", "invalid-runner-result", "supervision-failed"].includes(result.reason);
  }
  if (result.status !== "incomplete") return false;
  if (result.reason === "cleanup-failed") {
    return hasExactKeys(result, ["status", "reason", "cause"]) &&
      ["cap-completed", "timeout", "failed", "incomplete"].includes(result.cause);
  }
  return hasExactKeys(result, ["status", "reason"]) &&
    ["batch-incomplete", "shutdown", "startup-failed"].includes(result.reason);
}

function sameSmokeOutcome(first, second) {
  return isSmokeOutcome(first, false) && isSmokeOutcome(second, false) &&
    first.status === second.status && first.reason === second.reason &&
    first.cause === second.cause;
}

function logError(logger, message) {
  try {
    if (logger && typeof logger.error === "function") logger.error(message);
  } catch {
    return;
  }
}

function sanitizeFailure(failure, topic) {
  const offsetIsSafe = failure && typeof failure.offset === "string" &&
    /^(0|[1-9][0-9]*)$/.test(failure.offset) &&
    failure.offset.length <= 19 &&
    BigInt(failure.offset) <= MAX_KAFKA_OFFSET;
  return Object.freeze({
    classification: failure &&
      SAFE_FAILURE_CLASSIFICATIONS.has(failure.classification)
      ? failure.classification
      : "history-runner-supervision-failed",
    topic,
    partition: failure && Number.isInteger(failure.partition) &&
      failure.partition >= 0 && failure.partition < 6
      ? failure.partition
      : null,
    offset: offsetIsSafe ? failure.offset : null,
    ...(failure && SAFE_ERROR_NAMES.has(failure.errorName)
      ? { errorName: failure.errorName }
      : {}),
  });
}

function logTerminalFailure(logger, failure) {
  const context = [
    `classification=${failure.classification}`,
    `topic=${failure.topic}`,
  ];
  if (failure.partition !== null) context.push(`partition=${failure.partition}`);
  if (failure.offset !== null) context.push(`offset=${failure.offset}`);
  if (failure.errorName) context.push(`errorName=${failure.errorName}`);
  logError(logger, `V2 history consumer terminal failure: ${context.join(" ")}.`);
}

function validateDatabaseCollections({
  config,
  mongoClient,
  database,
  historyCollection,
  receiptCollection,
}) {
  if (!database || database.databaseName !== config.mongo.databaseName ||
      database.client !== mongoClient ||
      typeof database.collection !== "function") {
    throw new Error("Invalid V2 history database handle.");
  }
  const collections = [
    [historyCollection, HISTORY_COLLECTION_NAMES.history],
    [receiptCollection, HISTORY_COLLECTION_NAMES.receipts],
  ];
  for (const [collection, name] of collections) {
    if (!collection || collection.collectionName !== name ||
        collection.db !== database ||
        collection.db.client !== mongoClient) {
      throw new Error("Invalid V2 history collection handle.");
    }
  }
}

function createHistoryConsumerApplication({
  env = process.env,
  KafkaConstructor = Kafka,
  MongoClientConstructor = MongoClient,
  createStartup = createHistoryConsumerStartup,
  processObject = process,
  logger = console,
  onFailure,
} = {}) {
  const config = loadHistoryConsumerConfig(env);
  if (typeof KafkaConstructor !== "function" ||
      typeof MongoClientConstructor !== "function" ||
      typeof createStartup !== "function" ||
      (onFailure !== undefined && typeof onFailure !== "function")) {
    throw new Error("Invalid V2 history client or startup dependency.");
  }

  let kafka;
  try {
    kafka = new KafkaConstructor({
      clientId: "crypto-v2-history-consumer",
      brokers: [config.kafka.broker],
      connectionTimeout: config.kafka.options.connectionTimeout,
      requestTimeout: config.kafka.options.requestTimeout,
    });
  } catch {
    throw new Error("V2 history Kafka client construction failed.");
  }
  if (!kafka || typeof kafka.admin !== "function" ||
      typeof kafka.consumer !== "function") {
    throw new Error("Invalid V2 history Kafka client.");
  }

  let mongoClient;
  try {
    mongoClient = new MongoClientConstructor(config.mongo.uri, config.mongo.options);
  } catch {
    throw new Error("V2 history MongoDB client construction failed.");
  }
  if (!mongoClient || typeof mongoClient.connect !== "function" ||
      typeof mongoClient.close !== "function" ||
      typeof mongoClient.db !== "function") {
    throw new Error("Invalid V2 history MongoDB client.");
  }

  let admin;
  let database;
  let historyCollection;
  let receiptCollection;
  try {
    admin = kafka.admin();
    database = mongoClient.db(config.mongo.databaseName);
    historyCollection = database.collection(HISTORY_COLLECTION_NAMES.history);
    receiptCollection = database.collection(HISTORY_COLLECTION_NAMES.receipts);
    validateDatabaseCollections({
      config,
      mongoClient,
      database,
      historyCollection,
      receiptCollection,
    });
  } catch {
    throw new Error("V2 history client dependencies could not be created safely.");
  }

  const createConsumer = () => kafka.consumer({
    groupId: config.consumer.groupId,
    sessionTimeout: config.consumer.sessionTimeoutMs,
    heartbeatInterval: config.consumer.heartbeatIntervalMs,
    allowAutoTopicCreation: false,
  });
  let terminalFailureObserved = false;
  const failureHandler = (failure) => {
    terminalFailureObserved = true;
    const safeFailure = sanitizeFailure(failure, config.kafka.topic);
    if (onFailure) return onFailure(safeFailure);
    logTerminalFailure(logger, safeFailure);
  };

  let startup;
  try {
    startup = createStartup({
      config,
      admin,
      mongoClient,
      historyCollection,
      receiptCollection,
      createConsumer,
      onFailure: failureHandler,
    });
  } catch {
    throw new Error("V2 history startup supervisor setup failed.");
  }
  if (!startup || typeof startup.start !== "function" ||
      typeof startup.stop !== "function" ||
      typeof startup.waitForTerminalCleanup !== "function" ||
      (startup.getTerminalFailure !== undefined &&
        typeof startup.getTerminalFailure !== "function")) {
    throw new Error("Invalid V2 history startup supervisor.");
  }

  let startPromise;
  let stopPromise;
  let shutdownRequested = false;
  let signalController;

  function stop() {
    shutdownRequested = true;
    if (!stopPromise) {
      stopPromise = Promise.resolve().then(() => startup.stop());
    }
    return stopPromise;
  }

  function installSignalHandlers() {
    if (signalController && !signalController.removed) return signalController;
    if (!processObject || typeof processObject.on !== "function" ||
        typeof processObject.removeListener !== "function") {
      throw new Error("Invalid V2 history process signal handler.");
    }

    let signal = null;
    let shutdownPromise;
    let removed = false;
    let resolveSignal;
    const signalReceived = new Promise((resolve) => {
      resolveSignal = resolve;
    });

    function remove() {
      if (removed) return;
      removed = true;
      processObject.removeListener("SIGINT", onSigint);
      processObject.removeListener("SIGTERM", onSigterm);
    }

    function handleSignal(receivedSignal) {
      if (shutdownPromise) return shutdownPromise;
      signal = receivedSignal;
      shutdownRequested = true;
      shutdownPromise = (async () => {
        try {
          await stop();
          if ((config.firstRunSmoke && terminalFailureObserved) ||
              (typeof startup.getTerminalFailure === "function" &&
                startup.getTerminalFailure())) {
            processObject.exitCode = 1;
          }
        } catch {
          logError(logger, "V2 history consumer shutdown failed.");
          processObject.exitCode = 1;
        } finally {
          if (processObject.exitCode === undefined ||
              (config.firstRunSmoke && processObject.exitCode === 0)) {
            processObject.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
          }
          remove();
        }
      })();
      resolveSignal(receivedSignal);
      return shutdownPromise;
    }

    function onSigint() {
      void handleSignal("SIGINT");
    }

    function onSigterm() {
      void handleSignal("SIGTERM");
    }

    processObject.on("SIGINT", onSigint);
    processObject.on("SIGTERM", onSigterm);
    signalController = {
      remove,
      get removed() {
        return removed;
      },
      get signal() {
        return signal;
      },
      waitForShutdown() {
        return signalReceived.then(async (receivedSignal) => {
          if (shutdownPromise) await shutdownPromise;
          return receivedSignal;
        });
      },
    };
    return signalController;
  }

  function start() {
    if (shutdownRequested) {
      return Promise.reject(new Error("V2 history consumer shutdown was requested."));
    }
    if (startPromise) return startPromise;
    try {
      installSignalHandlers();
    } catch {
      return Promise.reject(new Error("V2 history signal handlers could not be installed."));
    }
    startPromise = Promise.resolve().then(() => startup.start());
    return startPromise;
  }

  function waitForTerminalCleanup() {
    return startup.waitForTerminalCleanup();
  }

  function waitForSmokeOutcome() {
    return Promise.resolve().then(() => {
      if (!config.firstRunSmoke || config.firstRunSmoke.enabled !== true || !startPromise) {
        throw new Error("V2 history smoke startup has not completed.");
      }
      return startPromise;
    }).then(() => {
      if (typeof startup.getSmokeOutcomeSnapshot !== "function" ||
          typeof startup.waitForSmokeOutcome !== "function" ||
          typeof startup.getTerminalFailure !== "function" ||
          !isSmokeOutcome(startup.getSmokeOutcomeSnapshot(), true)) {
        throw new Error("Invalid V2 history smoke supervisor.");
      }
      const signal = startup.waitForSmokeOutcome();
      if (!signal || typeof signal.then !== "function") {
        throw new Error("Invalid V2 history smoke outcome signal.");
      }
      return Promise.resolve(signal).then((outcome) => {
        if (!sameSmokeOutcome(outcome, startup.getSmokeOutcomeSnapshot())) {
          throw new Error("Invalid V2 history smoke outcome.");
        }
        return { status: outcome.status };
      });
    });
  }

  return {
    config,
    start,
    stop,
    waitForTerminalCleanup,
    waitForSmokeOutcome,
    isShutdownRequested: () => shutdownRequested,
    hasTerminalFailure: () => terminalFailureObserved ||
      (typeof startup.getTerminalFailure === "function" && !!startup.getTerminalFailure()),
    installSignalHandlers,
  };
}

async function runHistoryConsumer(options = {}) {
  // Pending promises do not keep Node alive; external supervisors own termination grace periods.
  const processObject = options.processObject || process;
  const logger = options.logger === undefined ? console : options.logger;
  let application;
  let signals;
  try {
    application = createHistoryConsumerApplication({
      ...options,
      processObject,
      logger,
    });
    signals = application.installSignalHandlers();
  } catch {
    logError(logger, "V2 history configuration or client setup failed.");
    processObject.exitCode = 1;
    return null;
  }

  let startupOutcome;
  try {
    startupOutcome = await Promise.race([
      Promise.resolve()
        .then(() => application.start())
        .then(
          () => ({ type: "started" }),
          () => ({ type: "failed" }),
        ),
      signals.waitForShutdown().then(() => ({ type: "signal" })),
    ]);

    if (startupOutcome.type === "signal") {
      await signals.waitForShutdown();
      return application;
    }
    if (startupOutcome.type === "failed") {
      if (signals.signal) {
        await signals.waitForShutdown();
        return application;
      }
      logError(logger, "V2 history consumer startup failed.");
      processObject.exitCode = 1;
      signals.remove();
      return null;
    }

    const observations = [
      application.waitForTerminalCleanup().then(
        (result) => ({ type: "terminal", result }),
        () => ({ type: "supervision-failed" }),
      ),
      signals.waitForShutdown().then(() => ({ type: "signal" })),
    ];
    const smokeEnabled = application.config.firstRunSmoke &&
      application.config.firstRunSmoke.enabled === true;
    if (smokeEnabled) {
      observations.push(application.waitForSmokeOutcome().then(
        (result) => ({ type: "smoke", result }),
        () => ({ type: "smoke-observation-failed" }),
      ));
    }
    const terminalOutcome = await Promise.race(observations);
    if (smokeEnabled && signals.signal) {
      if (terminalOutcome.type === "terminal" ||
          terminalOutcome.type === "supervision-failed") {
        processObject.exitCode = 1;
      }
      await signals.waitForShutdown();
      return application;
    }
    if (terminalOutcome.type === "signal") {
      await signals.waitForShutdown();
      return application;
    }
    if (terminalOutcome.type === "smoke-observation-failed") {
      processObject.exitCode = 1;
      logError(logger, "V2 history smoke outcome observation failed.");
      try {
        await application.stop();
      } catch {
        logError(logger, "V2 history consumer cleanup failed.");
      }
      signals.remove();
      return application;
    }
    if (terminalOutcome.type === "smoke") {
      if (terminalOutcome.result.status === "success" &&
          !application.isShutdownRequested() && !application.hasTerminalFailure()) {
        if (processObject.exitCode === undefined || processObject.exitCode === 0) {
          processObject.exitCode = 0;
        }
      } else {
        processObject.exitCode = 1;
        logError(logger, terminalOutcome.result.status === "success"
          ? "V2 history smoke success was rejected after shutdown or failure."
          : `V2 history smoke outcome: status=${terminalOutcome.result.status}.`);
      }
      signals.remove();
      return application;
    }
    if (terminalOutcome.type === "supervision-failed") {
      processObject.exitCode = 1;
      logError(logger, "V2 history terminal-failure supervision failed.");
      try {
        await application.stop();
      } catch {
        logError(logger, "V2 history consumer cleanup failed.");
      }
      signals.remove();
      return application;
    }

    processObject.exitCode = 1;
    if (terminalOutcome.result && terminalOutcome.result.cleanupFailure) {
      logError(logger, "V2 history terminal-failure cleanup failed.");
    }
    signals.remove();
    return application;
  } catch {
    processObject.exitCode = 1;
    logError(logger, "V2 history consumer runtime failed.");
    if (application) {
      try {
        await application.stop();
      } catch {
        logError(logger, "V2 history consumer cleanup failed.");
      }
    }
    if (signals) signals.remove();
    return null;
  }
}

function main() {
  return runHistoryConsumer({
    env: process.env,
    processObject: process,
    logger: console,
  });
}

if (require.main === module) {
  void main().catch(() => {
    logError(console, "V2 history consumer exited after an unexpected failure.");
    process.exitCode = 1;
  });
}

module.exports = {
  createHistoryConsumerApplication,
  main,
  runHistoryConsumer,
};
