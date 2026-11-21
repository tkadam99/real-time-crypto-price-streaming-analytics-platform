const {
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
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
const {
  verifyHistorySmokeTopicIdentity: defaultVerifyHistorySmokeTopicIdentity,
} = require("./historySmokeTopicPreflight");
const {
  verifyHistorySmokeGroup: defaultVerifyHistorySmokeGroup,
} = require("./historySmokeGroupPreflight");
const {
  executeHistorySmokeCommand: defaultExecuteHistorySmokeCommand,
} = require("./historySmokeCommandExecutor");
const { createHistoryConsumerRunner } = require("./historyConsumerRunner");
const { persistHistoryBatch } = require("./historyBatch");
const { ensureHistoryIndexes } = require("./historyIndexes");
const { verifyHistoryCollectionOwnership } =
  require("./historyCollectionOwnershipVerification");
const { HISTORY_COLLECTION_NAMES } = require("./historyCollectionInspection");

const SMOKE_EXECUTION_UNAVAILABLE =
  "V2 history smoke execution is unavailable until bounded runner controls are installed.";
const HISTORY_PARTITION_IDS = Object.freeze([0, 1, 2, 3, 4, 5]);

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

  if (config.firstRunSmoke !== undefined) {
    const smoke = config.firstRunSmoke;
    if (!smoke || smoke.enabled !== true ||
        !isBoundedInteger(smoke.maxRecords, 1, 100) ||
        !isBoundedInteger(smoke.maxRuntimeMs, 1000, 300000) ||
        config.kafka.expectedTopicId !== FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID) {
      throw new Error("Invalid V2 history first-run smoke startup configuration.");
    }
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
  verifyOwnership,
  verifyHistorySmokeTopicIdentity,
  verifyHistorySmokeGroup,
  executeHistorySmokeCommand,
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
      typeof verifyOwnership !== "function" ||
      typeof persistHistoryBatchImpl !== "function" ||
      typeof createRunner !== "function" ||
      typeof onFailure !== "function") {
    throw new Error("Invalid V2 history startup factory or failure handler.");
  }
  if (config.firstRunSmoke && config.firstRunSmoke.enabled === true &&
      (typeof verifyHistorySmokeTopicIdentity !== "function" ||
        typeof verifyHistorySmokeGroup !== "function" ||
        typeof executeHistorySmokeCommand !== "function" ||
        typeof admin.listGroups !== "function" ||
        typeof admin.describeGroups !== "function" ||
        typeof admin.fetchOffsets !== "function")) {
    throw new Error("Invalid V2 history smoke preflight dependency.");
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => expectedKeys.includes(key));
}

function isSmokeTopicIdentityResult(result, config) {
  return hasExactKeys(result, [
    "topic",
    "topicId",
    "partitionCount",
    "partitionIds",
  ]) &&
    result.topic === HISTORY_TOPIC &&
    result.topicId === config.kafka.expectedTopicId &&
    result.partitionCount === HISTORY_PARTITION_IDS.length &&
    Array.isArray(result.partitionIds) &&
    result.partitionIds.length === HISTORY_PARTITION_IDS.length &&
    result.partitionIds.every((partitionId, index) =>
      partitionId === HISTORY_PARTITION_IDS[index]);
}

function isSmokeGroupResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      result.groupId !== HISTORY_CONSUMER_GROUP_ID) {
    return false;
  }
  if (result.status === "absent") {
    return hasExactKeys(result, ["status", "groupId"]);
  }
  return result.status === "existing-empty-uncommitted" &&
    hasExactKeys(result, ["status", "groupId", "topic", "partitionIds"]) &&
    result.topic === HISTORY_TOPIC &&
    Array.isArray(result.partitionIds) &&
    result.partitionIds.length === HISTORY_PARTITION_IDS.length &&
    result.partitionIds.every((partitionId, index) =>
      partitionId === HISTORY_PARTITION_IDS[index]);
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

function isSmokeRunnerFailure(failure) {
  const keys = ["classification", "topic", "partition", "offset"];
  if (failure && Object.prototype.hasOwnProperty.call(failure, "errorName")) {
    keys.push("errorName");
  }
  return hasExactKeys(failure, keys) &&
    RUNNER_FAILURE_CLASSIFICATIONS.has(failure.classification) &&
    failure.topic === HISTORY_TOPIC &&
    (failure.partition === null || isBoundedInteger(failure.partition, 0, 5)) &&
    (failure.offset === null ||
      (typeof failure.offset === "string" &&
        /^(0|[1-9][0-9]*)$/.test(failure.offset) &&
        failure.offset.length <= 19 &&
        BigInt(failure.offset) <= 9223372036854775807n)) &&
    (!keys.includes("errorName") || SAFE_ERROR_NAMES.has(failure.errorName));
}

function isSmokeCompletion(result, allowPending) {
  if (!result || typeof result !== "object") return false;
  if (result.status === "pending") {
    return allowPending && hasExactKeys(result, ["status"]);
  }
  if (result.status === "cap-completed" || result.status === "timeout") {
    return hasExactKeys(result, ["status"]);
  }
  if (result.status === "failed") {
    return hasExactKeys(result, ["status", "failure"]) &&
      isSmokeRunnerFailure(result.failure);
  }
  return result.status === "incomplete" &&
    hasExactKeys(result, ["status", "reason"]) &&
    ["batch-incomplete", "shutdown", "startup-failed"].includes(result.reason);
}

function sameSmokeCompletion(first, second) {
  if (!isSmokeCompletion(first, false) || !isSmokeCompletion(second, false) ||
      first.status !== second.status) return false;
  if (first.status === "incomplete") return first.reason === second.reason;
  if (first.status !== "failed") return true;
  return ["classification", "topic", "partition", "offset", "errorName"]
    .every((key) => first.failure[key] === second.failure[key]);
}

function isSmokeRuntime(result) {
  return hasExactKeys(result, ["started", "elapsedMs", "deadlineExpired"]) &&
    typeof result.started === "boolean" &&
    Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0 &&
    typeof result.deadlineExpired === "boolean";
}

function copySmokeTrigger(result) {
  if (result.status === "failed") {
    return { status: "failed", reason: "runner-failure" };
  }
  if (result.status === "incomplete") {
    return { status: "incomplete", reason: result.reason };
  }
  return { status: result.status };
}

function createHistorySmokeSupervisor({
  runner,
  stop,
  getSupervisorFailure = () => null,
}) {
  if (typeof stop !== "function" || typeof getSupervisorFailure !== "function") {
    throw new Error("V2 history smoke supervisor cleanup is required.");
  }

  let outcome = Object.freeze({ status: "pending" });
  let claimed = false;
  let observedCompletion = null;
  let observationInvalid = false;
  let observationReady;
  let resolveOutcome;
  const outcomeSignal = new Promise((resolve) => { resolveOutcome = resolve; });

  function finish(result) {
    outcome = Object.freeze(result);
    resolveOutcome(outcome);
  }

  function begin(result) {
    if (claimed) return;
    claimed = true;
    Promise.resolve().then(async () => {
      try {
        const stopping = stop();
        if (!stopping || typeof stopping.then !== "function") {
          throw new Error("Invalid cleanup result.");
        }
        await stopping;
      } catch {
        finish({ status: "incomplete", reason: "cleanup-failed", cause: result.status });
        return;
      }

      if (result.status === "cap-completed") {
        try {
          await observationReady;
          const current = runner.getSmokeCompletionSnapshot();
          const failure = runner.getTerminalFailure();
          const supervisorFailure = getSupervisorFailure();
          const runtime = runner.getRuntimeSnapshot();
          if (observationInvalid || !sameSmokeCompletion(result, observedCompletion) ||
              !sameSmokeCompletion(result, current) ||
              !isSmokeRuntime(runtime) || !runtime.started ||
              (failure !== null && !isSmokeRunnerFailure(failure)) ||
              (supervisorFailure !== null &&
                (typeof supervisorFailure !== "object" || Array.isArray(supervisorFailure)))) {
            finish({ status: "failed", reason: "invalid-runner-result" });
          } else if (failure !== null || supervisorFailure !== null) {
            finish({ status: "failed", reason: "runner-failure" });
          } else if (runtime.deadlineExpired) {
            finish({ status: "timeout" });
          } else {
            finish({ status: "success" });
          }
        } catch {
          finish({ status: "failed", reason: "invalid-runner-result" });
        }
      } else if (result.status === "timeout") {
        finish({ status: "timeout" });
      } else if (result.status === "failed") {
        finish({ status: "failed", reason: result.reason || "runner-failure" });
      } else {
        finish({ status: "incomplete", reason: result.reason });
      }
    }).catch(() => {
      finish({ status: "failed", reason: "supervision-failed" });
    });
  }

  function invalidRunnerResult() {
    observationInvalid = true;
    begin({ status: "failed", reason: "invalid-runner-result" });
  }

  function notifyStopRequested() {
    if (claimed) return;
    try {
      const current = runner.getSmokeCompletionSnapshot();
      if (!isSmokeCompletion(current, true)) return invalidRunnerResult();
      begin(current.status === "pending"
        ? { status: "incomplete", reason: "shutdown" }
        : copySmokeTrigger(current));
    } catch {
      invalidRunnerResult();
    }
  }

  observationReady = Promise.resolve().then(() => {
    if (!runner || ["stop", "getSmokeCompletionSnapshot", "waitForSmokeCompletion",
      "getRuntimeSnapshot", "getTerminalFailure"].some(
      (method) => typeof runner[method] !== "function",
    )) {
      throw new Error("Invalid smoke runner.");
    }
    const current = runner.getSmokeCompletionSnapshot();
    const signal = runner.waitForSmokeCompletion();
    if (!signal || typeof signal.then !== "function") {
      throw new Error("Invalid smoke completion signal.");
    }
    Promise.resolve(signal).then((result) => {
      try {
        if (!sameSmokeCompletion(result, runner.getSmokeCompletionSnapshot())) {
          invalidRunnerResult();
          return;
        }
        observedCompletion = copySmokeTrigger(result);
        begin(observedCompletion);
      } catch {
        invalidRunnerResult();
      }
    }, invalidRunnerResult);
    if (!isSmokeCompletion(current, true)) invalidRunnerResult();
  }).catch(invalidRunnerResult);

  // Frozen outcomes are pending, success, timeout, failed with a reason, or
  // incomplete with a reason (and the original status on cleanup failure).
  // The wait settles after bounded cleanup; deferred cleanup may continue.
  return {
    getSmokeOutcomeSnapshot: () => outcome,
    waitForSmokeOutcome: () => outcomeSignal,
    notifyStopRequested,
  };
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
  verifyOwnership = verifyHistoryCollectionOwnership,
  verifyHistorySmokeTopicIdentity = defaultVerifyHistorySmokeTopicIdentity,
  verifyHistorySmokeGroup = defaultVerifyHistorySmokeGroup,
  executeHistorySmokeCommand = defaultExecuteHistorySmokeCommand,
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
    verifyOwnership,
    verifyHistorySmokeTopicIdentity,
    verifyHistorySmokeGroup,
    executeHistorySmokeCommand,
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
  const mongoOperations = new Set();
  const kafkaStartupOperations = new Set();
  let startPromise;
  let stopPromise;
  let cleanupPromise;
  let cleanupTailPromise;
  let mongoCleanupPromise;
  let deferredRunnerCleanupPromise;
  let deferredMongoClosePromise;
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
  let runnerStopOutcomePromise;
  let runnerStopSettled = false;
  let runnerConsumer;
  let terminalFailure = null;
  let terminalCleanupFailure = null;
  let terminalMonitorPromise;
  let smokeSupervisor;
  let resolveTerminalFailure;
  const terminalFailureSignal = new Promise((resolve) => {
    resolveTerminalFailure = resolve;
  });

  function trackOperations(sets, operation) {
    const pending = Promise.resolve().then(operation);
    for (const operations of sets) operations.add(pending);
    pending.then(
      () => {
        for (const operations of sets) operations.delete(pending);
      },
      () => {
        for (const operations of sets) operations.delete(pending);
      },
    );
    return pending;
  }

  function trackMongoOperation(operation) {
    return trackOperations([mongoOperations], operation);
  }

  function trackKafkaStartupOperation(operation) {
    return trackOperations([kafkaStartupOperations], operation);
  }

  function trackMongoAndKafkaStartupOperation(operation) {
    return trackOperations([mongoOperations, kafkaStartupOperations], operation);
  }

  async function waitForOperations(operations) {
    while (operations.size > 0) {
      await Promise.allSettled([...operations]);
    }
  }

  function disconnectAdmin() {
    if (!adminConnectionAttempted) return Promise.resolve();
    if (!adminDisconnectPromise) {
      adminDisconnectPromise = (async () => {
        await waitForOperations(kafkaStartupOperations);
        return admin.disconnect();
      })();
    }
    return adminDisconnectPromise;
  }

  function closeMongoClient() {
    if (!mongoConnectionAttempted) return Promise.resolve();
    if (!runnerStopSettled) {
      return Promise.reject(new Error("V2 history runner has not settled."));
    }
    if (!mongoClosePromise) {
      mongoClosePromise = Promise.resolve().then(() => mongoClient.close());
    }
    return mongoClosePromise;
  }

  function disconnectConsumer() {
    if (!consumerConnectionAttempted || !consumer) return Promise.resolve();
    if (!consumerDisconnectPromise) {
      consumerDisconnectPromise = (async () => {
        await waitForOperations(kafkaStartupOperations);
        if (consumerStopPromise) await Promise.allSettled([consumerStopPromise]);
        return consumer.disconnect();
      })();
    }
    return consumerDisconnectPromise;
  }

  function stopConsumerOnce() {
    if (!consumer || !consumerConnectionAttempted) return Promise.resolve();
    if (!consumerStopPromise) {
      consumerStopPromise = (async () => {
        await waitForOperations(kafkaStartupOperations);
        return consumer.stop();
      })();
    }
    return consumerStopPromise;
  }

  function stopRunner() {
    if (runner) {
      if (!runnerStopPromise) {
        runnerStopPromise = Promise.resolve().then(() => runner.stop());
        runnerStopOutcomePromise = runnerStopPromise.then(
          () => {
            runnerStopSettled = true;
            return "fulfilled";
          },
          () => {
            runnerStopSettled = true;
            return "rejected";
          },
        );
      }
      return runnerStopPromise;
    }
    runnerStopSettled = true;
    runnerStopOutcomePromise = Promise.resolve("fulfilled");
    return Promise.resolve();
  }

  function deferMongoCloseUntilOperationsSettle() {
    if (deferredMongoClosePromise) return deferredMongoClosePromise;
    deferredMongoClosePromise = waitForOperations(mongoOperations)
      .then(() => closeMongoClient())
      .then(
        () => undefined,
        () => {
          terminalCleanupFailure = "V2 history deferred MongoDB cleanup failed.";
        },
      );
    return deferredMongoClosePromise;
  }

  function cleanupKafka(deadline) {
    return (async () => {
      const failures = [];

      async function attempt(label, operation) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          Promise.resolve().then(operation).then(
            () => undefined,
            () => undefined,
          );
          failures.push(label);
          return;
        }
        try {
          await boundedCall(operation, remainingMs, label);
        } catch {
          failures.push(label);
        }
      }

      await attempt("Kafka consumer stop", stopConsumerOnce);
      await attempt("Kafka consumer disconnect", disconnectConsumer);
      await attempt("Kafka admin disconnect", disconnectAdmin);
      return failures;
    })();
  }

  function cleanupMongo(deadline) {
    if (mongoCleanupPromise) return mongoCleanupPromise;
    mongoCleanupPromise = (async () => {
      const failures = [];

      async function attempt(label, operation) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          Promise.resolve().then(operation).then(
            () => undefined,
            () => undefined,
          );
          failures.push(label);
          return;
        }
        try {
          await boundedCall(operation, remainingMs, label);
        } catch {
          failures.push(label);
        }
      }

      try {
        const remainingMs = deadline - Date.now();
        if (mongoOperations.size > 0) {
          if (remainingMs <= 0) throw new Error("MongoDB work is still active.");
          await boundedCall(
            () => waitForOperations(mongoOperations),
            remainingMs,
            "MongoDB operations",
          );
        }
        await attempt("MongoDB client close", closeMongoClient);
      } catch {
        failures.push("MongoDB operations");
        deferMongoCloseUntilOperationsSettle();
      }
      return failures;
    })();
    return mongoCleanupPromise;
  }

  function cleanupAfterRunner(deadline) {
    if (cleanupTailPromise) return cleanupTailPromise;
    cleanupTailPromise = Promise.all([
      cleanupKafka(deadline),
      cleanupMongo(deadline),
    ]).then(([kafkaFailures, mongoFailures]) => [
      ...kafkaFailures,
      ...mongoFailures,
    ]);
    return cleanupTailPromise;
  }

  function deferCleanupUntilRunnerSettles() {
    if (deferredRunnerCleanupPromise) return deferredRunnerCleanupPromise;
    const runnerOutcome = runnerStopOutcomePromise || Promise.resolve("fulfilled");
    deferredRunnerCleanupPromise = runnerOutcome
      .then(async (outcome) => {
        if (outcome === "rejected") {
          terminalCleanupFailure = "V2 history runner stop failed after its shutdown deadline.";
        }
        const failures = await cleanupAfterRunner(Date.now() + shutdownTimeoutMs);
        if (failures.length > 0) {
          terminalCleanupFailure = "V2 history deferred shutdown cleanup failed.";
        }
      })
      .catch(() => {
        terminalCleanupFailure = "V2 history deferred shutdown cleanup failed.";
      });
    return deferredRunnerCleanupPromise;
  }

  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const failures = [];
      const deadline = Date.now() + shutdownTimeoutMs;

      stopRunner();
      let runnerOutcome;
      try {
        runnerOutcome = await boundedCall(
          () => runnerStopOutcomePromise,
          Math.max(0, deadline - Date.now()),
          "history runner stop",
        );
      } catch {
        failures.push("history runner stop");
        if (!runnerStopSettled) {
          deferCleanupUntilRunnerSettles();
          return failures;
        }
      }

      if (runnerOutcome === "rejected") failures.push("history runner stop");
      const tailFailures = await cleanupAfterRunner(deadline);
      return [...failures, ...tailFailures];
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
      let smokeExecutionBlocked = false;
      let stage = "Kafka admin connection";
      try {
        adminConnectionAttempted = true;
        await boundedCall(
          () => trackKafkaStartupOperation(() => admin.connect()),
          config.kafka.options.connectionTimeout,
          stage,
        );
        checkCancellation();

        stage = "MongoDB connection";
        mongoConnectionAttempted = true;
        await boundedCall(
          () => trackMongoOperation(() => mongoClient.connect()),
          config.mongo.options.timeoutMS,
          stage,
        );
        checkCancellation();

        stage = "Kafka and MongoDB identity preflight";
        await boundedCall(
          () => trackMongoAndKafkaStartupOperation(
            () => verifyPreflights({ admin, mongoClient, config }),
          ),
          startupTimeoutMs,
          stage,
        );
        checkCancellation();

        if (config.firstRunSmoke && config.firstRunSmoke.enabled === true) {
          stage = "V2 history smoke topic-ID preflight";
          const topicResult = await boundedCall(
            () => trackMongoAndKafkaStartupOperation(() => {
              checkCancellation();
              return verifyHistorySmokeTopicIdentity({
                config,
                executeCommand: executeHistorySmokeCommand,
              });
            }),
            startupTimeoutMs,
            stage,
          );
          if (!isSmokeTopicIdentityResult(topicResult, config)) {
            throw new Error("V2 history smoke topic-ID preflight returned an invalid result.");
          }
          checkCancellation();

          stage = "V2 history smoke consumer-group preflight";
          const groupResult = await boundedCall(
            () => trackMongoAndKafkaStartupOperation(() => {
              checkCancellation();
              return verifyHistorySmokeGroup({ admin, config });
            }),
            startupTimeoutMs,
            stage,
          );
          if (!isSmokeGroupResult(groupResult)) {
            throw new Error("V2 history smoke consumer-group preflight returned an invalid result.");
          }
          checkCancellation();
        }

        stage = "history collection ownership verification";
        const ownershipResult = await boundedCall(
          () => trackMongoOperation(() => verifyOwnership({
            database: historyCollection.db,
            mongoClient,
            historyCollection,
            receiptCollection,
          })),
          startupTimeoutMs,
          stage,
        );
        if (!ownershipResult ||
            ownershipResult.status !== "verified" ||
            ownershipResult.databaseName !== HISTORY_DATABASE_NAME ||
            !ownershipResult.collections ||
            ownershipResult.collections.history !== HISTORY_COLLECTION_NAMES.history ||
            ownershipResult.collections.receipts !== HISTORY_COLLECTION_NAMES.receipts) {
          throw new Error("V2 history ownership verification returned an invalid result.");
        }
        checkCancellation();

        if (config.firstRunSmoke && config.firstRunSmoke.enabled === true) {
          stage = "V2 history smoke index verification";
          const indexes = ownershipResult.indexes;
          if (!hasExactKeys(indexes, ["historyTtl", "receiptsTtl"]) ||
              indexes.historyTtl !== "verified" ||
              indexes.receiptsTtl !== "absent") {
            throw new Error("V2 history smoke indexes are missing or incompatible.");
          }
          checkCancellation();

          stage = "V2 history smoke consumer-group recheck";
          const groupResult = await boundedCall(
            () => trackMongoAndKafkaStartupOperation(() => {
              checkCancellation();
              return verifyHistorySmokeGroup({ admin, config });
            }),
            startupTimeoutMs,
            stage,
          );
          if (!isSmokeGroupResult(groupResult)) {
            throw new Error("V2 history smoke consumer-group recheck returned an invalid result.");
          }
          checkCancellation();

          stage = "V2 history smoke execution";
          smokeExecutionBlocked = true;
          throw new Error(SMOKE_EXECUTION_UNAVAILABLE);
        }

        stage = "Kafka admin disconnect";
        await boundedCall(disconnectAdmin, config.kafka.options.requestTimeout, stage);
        checkCancellation();

        stage = "history index setup";
        await boundedCall(
          () => trackMongoOperation(
            () => ensureIndexes({ historyCollection, receiptCollection }),
          ),
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
        const trackedPersistBatch = (envelopes) => trackMongoOperation(
          () => persistBatch(envelopes),
        );
        stage = "history runner creation";
        runner = createRunner({
          consumer: runnerConsumer,
          persistBatch: trackedPersistBatch,
          config: {
            groupId: config.consumer.groupId,
            partitionsConsumedConcurrently:
              config.consumer.partitionsConsumedConcurrently,
            heartbeatIntervalMs: config.consumer.heartbeatIntervalMs,
            heartbeatTimeoutMs: config.consumer.heartbeatTimeoutMs,
            ...(config.firstRunSmoke ? { firstRunSmoke: config.firstRunSmoke } : {}),
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
          () => trackKafkaStartupOperation(() => consumer.connect()),
          config.kafka.options.connectionTimeout,
          stage,
        );
        checkCancellation();

        stage = "history runner startup";
        await boundedCall(
          () => trackKafkaStartupOperation(() => runner.start()),
          config.kafka.options.requestTimeout,
          stage,
        );
        checkCancellation();
        superviseRunnerTerminalFailure();
        if (config.firstRunSmoke) {
          smokeSupervisor = createHistorySmokeSupervisor({
            runner,
            stop,
            getSupervisorFailure: () => terminalFailure,
          });
        }
        return runner;
      } catch {
        const cleanupFailures = await cleanup();
        const details = cleanupFailures.length
          ? ` Cleanup failed: ${cleanupFailures.join(", ")}.`
          : "";
        if (stopRequested) {
          throw new Error(`V2 history startup cancelled.${details}`);
        }
        if (smokeExecutionBlocked) {
          throw new Error(`${SMOKE_EXECUTION_UNAVAILABLE}${details}`);
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
    if (smokeSupervisor) smokeSupervisor.notifyStopRequested();
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
    getSmokeOutcomeSnapshot: () => smokeSupervisor
      ? smokeSupervisor.getSmokeOutcomeSnapshot()
      : null,
    waitForSmokeOutcome: () => smokeSupervisor
      ? smokeSupervisor.waitForSmokeOutcome()
      : Promise.resolve(null),
  };
}

module.exports = {
  createHistoryConsumerStartup,
  createHistorySmokeSupervisor,
};
