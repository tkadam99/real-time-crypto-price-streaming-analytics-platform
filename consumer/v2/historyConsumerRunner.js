const {
  processHistoryPartitionBatch,
  V2_TOPIC,
} = require("./historyConsumerCore");
const {
  CLOSE_REASONS,
  createHistorySmokeAdmissionController,
} = require("./historySmokeAdmissionController");

const HISTORY_CONSUMER_GROUP_ID = "crypto-v2-history-group";
const DEFAULT_PARTITIONS_CONCURRENTLY = 1;
const MAX_PARTITIONS_CONCURRENTLY = 2;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5000;
const MIN_HEARTBEAT_INTERVAL_MS = 100;
const MIN_HEARTBEAT_TIMEOUT_MS = 10;
const MAX_HEARTBEAT_INTERVAL_MS = 30000;
const MAX_KAFKA_OFFSET = 9223372036854775807n;
const CORE_FAILURE_CLASSIFICATIONS = new Set([
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
]);
const SAFE_ERROR_NAMES = new Set([
  "Error",
  "SyntaxError",
  "TypeError",
  "RangeError",
  "ReferenceError",
]);
const RUNNER_FAILURE_CLASSIFICATIONS = new Set([
  ...CORE_FAILURE_CLASSIFICATIONS,
  "unexpected-kafka-batch",
  "invalid-kafka-partition",
  "invalid-kafka-batch-context",
  "heartbeat-failed",
  "heartbeat-timeout",
  "history-processing-failed",
  "invalid-history-processing-result",
  "offset-commit-failed",
  "kafka-consumer-run-failed",
]);

function safeErrorName(error) {
  return error && SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
}

function isValidCoreProgress(result, partition, messages) {
  if (!result || result.cancelled === true ||
      result.topic !== V2_TOPIC || result.partition !== partition ||
      !Number.isInteger(result.committableCount) || result.committableCount < 0 ||
      !Array.isArray(result.committablePrefix) ||
      result.committablePrefix.length !== result.committableCount ||
      result.committableCount > messages.length ||
      (result.failure !== null &&
        (!result.failure || typeof result.failure !== "object" ||
          Array.isArray(result.failure))) ||
      (result.committableCount === 0) !== (result.nextOffset === null)) {
    return false;
  }

  let previousOffset = null;
  for (let index = 0; index < result.committablePrefix.length; index += 1) {
    const item = result.committablePrefix[index];
    if (!item || !["inserted", "replay"].includes(item.status) ||
        typeof item.offset !== "string" ||
        !/^(0|[1-9][0-9]*)$/.test(item.offset) ||
        !messages[index] || item.offset !== messages[index].offset) {
      return false;
    }
    const offset = BigInt(item.offset);
    if (offset >= MAX_KAFKA_OFFSET ||
        (previousOffset !== null && offset <= previousOffset)) {
      return false;
    }
    previousOffset = offset;
  }

  if (result.committableCount === 0) {
    return result.failure !== null &&
      result.failure.topic === V2_TOPIC &&
      result.failure.partition === partition &&
      typeof result.failure.classification === "string" &&
      result.failure.offset === (
        messages[0] && typeof messages[0].offset === "string"
          ? messages[0].offset
          : null
      ) &&
      CORE_FAILURE_CLASSIFICATIONS.has(result.failure.classification);
  }
  if (typeof result.nextOffset !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(result.nextOffset)) {
    return false;
  }
  const nextOffset = BigInt(result.nextOffset);
  if (nextOffset > MAX_KAFKA_OFFSET ||
      nextOffset !== previousOffset + 1n) {
    return false;
  }
  if (result.failure === null) return result.committableCount === messages.length;
  return result.committableCount < messages.length &&
    result.failure.topic === V2_TOPIC &&
    result.failure.partition === partition &&
    typeof result.failure.classification === "string" &&
    result.failure.offset === (
      messages[result.committableCount] &&
      typeof messages[result.committableCount].offset === "string"
        ? messages[result.committableCount].offset
        : null
    ) &&
    CORE_FAILURE_CLASSIFICATIONS.has(result.failure.classification);
}

function createFailure(classification, partition = null, offset = null, error) {
  return {
    classification,
    topic: V2_TOPIC,
    partition,
    offset: typeof offset === "string" ? offset : null,
    ...(error ? { errorName: safeErrorName(error) } : {}),
  };
}

function invokeHeartbeat(heartbeat, timeoutMs) {
  let timeout;
  const observedHeartbeat = Promise.resolve()
    .then(() => heartbeat())
    .then(
      () => ({ status: "fulfilled" }),
      (error) => ({ status: "rejected", error }),
    );
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });

  return Promise.race([observedHeartbeat, timeoutPromise])
    .finally(() => clearTimeout(timeout));
}

function createHeartbeatPump(heartbeat, intervalMs, timeoutMs, onFailure) {
  let stopped = false;
  let timer = null;
  let resolveDelay = null;
  let failure = null;

  const completion = (async () => {
    while (!stopped) {
      await new Promise((resolve) => {
        resolveDelay = resolve;
        timer = setTimeout(() => {
          timer = null;
          resolveDelay = null;
          resolve();
        }, intervalMs);
      });
      if (stopped) break;

      const heartbeatResult = await invokeHeartbeat(heartbeat, timeoutMs);
      if (heartbeatResult.status === "timeout") {
        failure = { classification: "heartbeat-timeout" };
        onFailure(failure);
        break;
      }
      if (heartbeatResult.status === "rejected") {
        failure = { classification: "heartbeat-failed", error: heartbeatResult.error };
        onFailure(failure);
        break;
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (resolveDelay) {
        const resolve = resolveDelay;
        resolveDelay = null;
        resolve();
      }
      await completion;
      return failure;
    },
  };
}

function validateConfiguration(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("History consumer configuration is required.");
  }
  const groupId = config.groupId;
  if (groupId !== HISTORY_CONSUMER_GROUP_ID) {
    throw new Error("History consumer must use its dedicated V2 group.");
  }

  const partitionsConsumedConcurrently = config.partitionsConsumedConcurrently === undefined
    ? DEFAULT_PARTITIONS_CONCURRENTLY
    : config.partitionsConsumedConcurrently;
  if (!Number.isInteger(partitionsConsumedConcurrently) ||
      partitionsConsumedConcurrently < 1 ||
      partitionsConsumedConcurrently > MAX_PARTITIONS_CONCURRENTLY) {
    throw new Error(
      `partitionsConsumedConcurrently must be between 1 and ${MAX_PARTITIONS_CONCURRENTLY}.`,
    );
  }

  const heartbeatIntervalMs = config.heartbeatIntervalMs === undefined
    ? DEFAULT_HEARTBEAT_INTERVAL_MS
    : config.heartbeatIntervalMs;
  if (!Number.isInteger(heartbeatIntervalMs) ||
      heartbeatIntervalMs < MIN_HEARTBEAT_INTERVAL_MS ||
      heartbeatIntervalMs > MAX_HEARTBEAT_INTERVAL_MS) {
    throw new Error(
      `heartbeatIntervalMs must be between ${MIN_HEARTBEAT_INTERVAL_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}.`,
    );
  }

  const heartbeatTimeoutMs = config.heartbeatTimeoutMs === undefined
    ? DEFAULT_HEARTBEAT_TIMEOUT_MS
    : config.heartbeatTimeoutMs;
  if (!Number.isInteger(heartbeatTimeoutMs) ||
      heartbeatTimeoutMs < MIN_HEARTBEAT_TIMEOUT_MS ||
      heartbeatTimeoutMs > MAX_HEARTBEAT_INTERVAL_MS) {
    throw new Error(
      `heartbeatTimeoutMs must be between ${MIN_HEARTBEAT_TIMEOUT_MS} and ${MAX_HEARTBEAT_INTERVAL_MS}.`,
    );
  }

  const firstRunSmoke = config.firstRunSmoke;
  if (firstRunSmoke !== undefined &&
      (!firstRunSmoke || typeof firstRunSmoke !== "object" ||
        Array.isArray(firstRunSmoke) || firstRunSmoke.enabled !== true ||
        !Number.isInteger(firstRunSmoke.maxRecords) ||
        firstRunSmoke.maxRecords < 1 || firstRunSmoke.maxRecords > 100 ||
        !Number.isInteger(firstRunSmoke.maxRuntimeMs) ||
        firstRunSmoke.maxRuntimeMs < 1000 ||
        firstRunSmoke.maxRuntimeMs > 300000)) {
    throw new Error("Invalid V2 history first-run smoke runner configuration.");
  }

  return {
    groupId,
    partitionsConsumedConcurrently,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
    firstRunSmoke,
  };
}

function validateDependencies({ consumer, processBatch, persistBatch, onFailure }) {
  if (!consumer || typeof consumer.subscribe !== "function" ||
      typeof consumer.run !== "function" ||
      typeof consumer.commitOffsets !== "function" ||
      typeof consumer.pause !== "function" ||
      typeof consumer.stop !== "function") {
    throw new Error("Invalid Kafka history consumer.");
  }
  if (typeof processBatch !== "function" || typeof persistBatch !== "function") {
    throw new Error("History processing and persistence functions are required.");
  }
  if (typeof onFailure !== "function") {
    throw new Error("A sanitized history-consumer failure handler is required.");
  }
}

function createHistoryConsumerRunner({
  consumer,
  processBatch = processHistoryPartitionBatch,
  persistBatch,
  config = {},
  onFailure,
}) {
  const settings = validateConfiguration(config);
  validateDependencies({ consumer, processBatch, persistBatch, onFailure });
  const admissionController = settings.firstRunSmoke
    ? createHistorySmokeAdmissionController({
      maxRecords: settings.firstRunSmoke.maxRecords,
    })
    : null;
  const smokeMaxRuntimeMs = settings.firstRunSmoke
    ? settings.firstRunSmoke.maxRuntimeMs
    : null;

  let startPromise;
  let stopPromise;
  let runPromise;
  let runStarted = false;
  let stopRequested = false;
  const cancellationController = new AbortController();
  let failureHandlerFailed = false;
  let terminalPauseFailed = false;
  let terminalFailure = null;
  let smokeStartedAt = null;
  let smokeStoppedElapsedMs = null;
  let deadlineExpired = false;
  let deadlineTimer = null;
  let resolveTerminalFailure;
  const terminalFailureSignal = new Promise((resolve) => {
    resolveTerminalFailure = resolve;
  });
  const inFlight = new Set();

  function clearDeadlineTimer() {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  }

  function checkDeadline() {
    if (smokeStartedAt === null || smokeStoppedElapsedMs !== null ||
        deadlineExpired) {
      return deadlineExpired;
    }
    if (performance.now() - smokeStartedAt >= smokeMaxRuntimeMs) {
      deadlineExpired = true;
      clearDeadlineTimer();
      admissionController.close(CLOSE_REASONS.DEADLINE);
      cancellationController.abort();
    }
    return deadlineExpired;
  }

  function scheduleDeadline() {
    const remaining = smokeMaxRuntimeMs - (performance.now() - smokeStartedAt);
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      if (!checkDeadline()) scheduleDeadline();
    }, Math.max(1, Math.ceil(remaining)));
  }

  function stopDeadline() {
    if (smokeStartedAt === null || smokeStoppedElapsedMs !== null) return;
    checkDeadline();
    smokeStoppedElapsedMs = Math.max(0, performance.now() - smokeStartedAt);
    clearDeadlineTimer();
  }

  function reportTerminalFailure(failure) {
    if (terminalFailure) return terminalFailure;

    terminalFailure = Object.freeze({
      classification: RUNNER_FAILURE_CLASSIFICATIONS.has(failure.classification)
        ? failure.classification
        : "history-processing-failed",
      topic: V2_TOPIC,
      partition: Number.isInteger(failure.partition) &&
        failure.partition >= 0 && failure.partition < 6
        ? failure.partition
        : null,
      offset: typeof failure.offset === "string" &&
        /^(0|[1-9][0-9]*)$/.test(failure.offset)
        ? failure.offset
        : null,
      ...(SAFE_ERROR_NAMES.has(failure.errorName)
        ? { errorName: failure.errorName }
        : {}),
    });
    cancellationController.abort();
    resolveTerminalFailure(terminalFailure);

    try {
      consumer.pause([{ topic: V2_TOPIC }]);
    } catch {
      terminalPauseFailed = true;
    }

    try {
      const notification = onFailure(terminalFailure);
      Promise.resolve(notification).catch(() => {
        failureHandlerFailed = true;
      });
    } catch {
      failureHandlerFailed = true;
    }
    return terminalFailure;
  }

  function assignmentIsCurrent(batchContext) {
    try {
      return !stopRequested &&
        !terminalFailure &&
        batchContext.isRunning() &&
        !batchContext.isStale();
    } catch {
      return false;
    }
  }

  async function handleBatch(batchContext) {
    const batch = batchContext && batchContext.batch;
    const partition = batch && batch.partition;
    const firstOffset = batch && batch.messages && batch.messages[0]
      ? batch.messages[0].offset
      : null;

    if (checkDeadline() || stopRequested || terminalFailure ||
        cancellationController.signal.aborted) {
      return;
    }
    if (!batch || batch.topic !== V2_TOPIC || !Array.isArray(batch.messages)) {
      reportTerminalFailure(
        createFailure("unexpected-kafka-batch", partition, firstOffset),
      );
      return;
    }
    if (!Number.isInteger(partition) || partition < 0 || partition >= 6) {
      reportTerminalFailure(
        createFailure("invalid-kafka-partition", partition, firstOffset),
      );
      return;
    }
    if (batch.messages.length === 0) return;
    if (typeof batchContext.heartbeat !== "function" ||
        typeof batchContext.isRunning !== "function" ||
        typeof batchContext.isStale !== "function") {
      reportTerminalFailure(
        createFailure("invalid-kafka-batch-context", partition, firstOffset),
      );
      return;
    }

    let messages = batch.messages;
    if (admissionController) {
      const reservation = admissionController.reserve(partition, messages.length);
      if (reservation.admittedRecords === 0) return;
      messages = messages.slice(0, reservation.admittedRecords);
    }

    const heartbeatPump = createHeartbeatPump(
      batchContext.heartbeat,
      settings.heartbeatIntervalMs,
      settings.heartbeatTimeoutMs,
      (failure) => {
        reportTerminalFailure(createFailure(
          failure.classification,
          partition,
          firstOffset,
          failure.error,
        ));
      },
    );
    let coreResult;
    let coreError;
    try {
      coreResult = await processBatch({
        partition,
        messages,
        persistBatch,
        signal: cancellationController.signal,
      });
    } catch (error) {
      coreError = error;
    }
    const heartbeatError = await heartbeatPump.stop();
    checkDeadline();

    if (heartbeatError) {
      reportTerminalFailure(
        createFailure(
          heartbeatError.classification,
          partition,
          firstOffset,
          heartbeatError.error,
        ),
      );
      return;
    }
    if (coreError) {
      if (cancellationController.signal.aborted) return;
      reportTerminalFailure(
        createFailure("history-processing-failed", partition, firstOffset, coreError),
      );
      return;
    }
    if (cancellationController.signal.aborted || stopRequested || terminalFailure) return;
    if (coreResult && coreResult.cancelled === true) {
      reportTerminalFailure(
        createFailure("history-processing-failed", partition, firstOffset),
      );
      return;
    }
    if (!isValidCoreProgress(coreResult, partition, messages)) {
      reportTerminalFailure(
        createFailure("invalid-history-processing-result", partition, firstOffset),
      );
      return;
    }

    if (coreResult.nextOffset !== null) {
      if (!assignmentIsCurrent(batchContext)) return;
      if (!assignmentIsCurrent(batchContext)) return;
      if (checkDeadline()) return;

      try {
        await consumer.commitOffsets([{
          topic: V2_TOPIC,
          partition,
          offset: coreResult.nextOffset,
        }]);
      } catch (error) {
        reportTerminalFailure(
          createFailure(
            "offset-commit-failed",
            partition,
            coreResult.nextOffset,
            error,
          ),
        );
        return;
      }
    }

    if (coreResult.failure) {
      reportTerminalFailure({
        classification: coreResult.failure.classification,
        topic: V2_TOPIC,
        partition,
        offset: typeof coreResult.failure.offset === "string"
          ? coreResult.failure.offset
          : null,
        ...(coreResult.failure.errorName
          ? {
            errorName: SAFE_ERROR_NAMES.has(coreResult.failure.errorName)
              ? coreResult.failure.errorName
              : "Error",
          }
          : {}),
      });
    }
  }

  async function eachBatch(batchContext) {
    const processing = handleBatch(batchContext);
    inFlight.add(processing);
    try {
      await processing;
    } finally {
      inFlight.delete(processing);
    }
  }

  async function start() {
    if (stopRequested) throw new Error("History consumer is stopping.");
    if (terminalFailure) throw new Error("History consumer has failed terminally.");
    if (startPromise) return startPromise;

    startPromise = (async () => {
      try {
        await consumer.subscribe({ topic: V2_TOPIC, fromBeginning: true });
      } catch {
        throw new Error("Unable to subscribe the V2 history consumer.");
      }
      if (stopRequested) return;

      runStarted = true;
      if (admissionController) {
        smokeStartedAt = performance.now();
        scheduleDeadline();
      }
      try {
        runPromise = Promise.resolve(consumer.run({
          autoCommit: false,
          eachBatchAutoResolve: false,
          partitionsConsumedConcurrently: settings.partitionsConsumedConcurrently,
          eachBatch,
        })).then(
          () => undefined,
          () => {
            if (!stopRequested) {
              reportTerminalFailure(createFailure("kafka-consumer-run-failed"));
            }
          },
        );
      } catch {
        stopDeadline();
        runStarted = false;
        throw new Error("Unable to start the V2 history consumer.");
      }
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopDeadline();
    stopRequested = true;
    if (admissionController) admissionController.close(CLOSE_REASONS.SHUTDOWN);
    cancellationController.abort();
    stopPromise = (async () => {
      const failures = [];

      if (startPromise) {
        try {
          await startPromise;
        } catch {
          failures.push("history consumer startup");
        }
      }
      if (runStarted) {
        try {
          consumer.pause([{ topic: V2_TOPIC }]);
          terminalPauseFailed = false;
        } catch {
          failures.push("history consumer pause");
        }
      }

      const active = [...inFlight];
      await Promise.allSettled(active);

      if (runStarted) {
        try {
          await consumer.stop();
        } catch {
          failures.push("history consumer stop");
        }
        runStarted = false;
      }
      if (runPromise) {
        try {
          await runPromise;
        } catch {
          failures.push("history consumer run");
        }
      }
      if (terminalPauseFailed) failures.push("terminal failure pause");
      if (failureHandlerFailed) failures.push("history consumer failure handler");
      if (failures.length > 0) {
        throw new Error(`History consumer cleanup failed: ${failures.join(", ")}.`);
      }
    })();
    return stopPromise;
  }

  return {
    start,
    stop,
    getTerminalFailure: () => terminalFailure,
    waitForTerminalFailure: () => terminalFailureSignal,
    getAdmissionSnapshot: () => admissionController
      ? admissionController.snapshot()
      : null,
    getRuntimeSnapshot: () => admissionController
      ? Object.freeze({
        started: smokeStartedAt !== null,
        elapsedMs: smokeStartedAt === null
          ? 0
          : smokeStoppedElapsedMs === null
            ? Math.max(0, performance.now() - smokeStartedAt)
            : smokeStoppedElapsedMs,
        deadlineExpired,
      })
      : null,
  };
}

module.exports = {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  HISTORY_CONSUMER_GROUP_ID,
  MAX_PARTITIONS_CONCURRENTLY,
  V2_TOPIC,
  createHistoryConsumerRunner,
};
