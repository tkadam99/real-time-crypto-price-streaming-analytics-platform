const {
  parseEnvelope,
  partitionForSymbol,
  serializeSourceIdentity,
} = require("./eventContract");

const V2_TOPIC = "crypto-prices-v2";
const PARTITION_COUNT = 6;
const MAX_MESSAGES_PER_PERSISTENCE_CALL = 100;
const MAX_KAFKA_OFFSET = 9223372036854775807n;

function failureResult(partition, offset, classification, error) {
  return {
    classification,
    topic: V2_TOPIC,
    partition,
    offset: typeof offset === "string" ? offset : null,
    ...(error && error.name ? { errorName: error.name } : {}),
  };
}

function createResult(partition) {
  return {
    topic: V2_TOPIC,
    partition,
    committablePrefix: [],
    committableCount: 0,
    nextOffset: null,
    persistedAfterFailure: [],
    failure: null,
  };
}

function parseKafkaOffset(offset) {
  if (typeof offset !== "string" || !/^(0|[1-9][0-9]*)$/.test(offset)) {
    return null;
  }
  const parsed = BigInt(offset);
  return parsed <= MAX_KAFKA_OFFSET ? parsed : null;
}

function decodeMessageValue(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (typeof value === "string") return value;
  throw new TypeError("Kafka message value must be a Buffer or string.");
}

function persistenceFailure(record, classification, error) {
  return failureResult(
    record.partition,
    record.offset,
    classification,
    error,
  );
}

function appendCommittable(result, record, status) {
  result.committablePrefix.push({ offset: record.offset, status });
  result.committableCount += 1;
  result.nextOffset = (record.kafkaOffset + 1n).toString();
}

async function processHistoryPartitionBatch({
  partition,
  messages,
  persistBatch,
}) {
  const result = createResult(partition);
  if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITION_COUNT) {
    result.failure = failureResult(partition, null, "invalid-kafka-partition");
    return result;
  }
  if (!Array.isArray(messages)) {
    throw new Error("Kafka partition messages must be an array.");
  }
  if (typeof persistBatch !== "function") {
    throw new Error("A persistence-batch function is required.");
  }

  let previousOffset = null;
  let prefixOpen = true;

  for (let start = 0; start < messages.length && prefixOpen;
    start += MAX_MESSAGES_PER_PERSISTENCE_CALL) {
    const messageChunk = messages.slice(
      start,
      start + MAX_MESSAGES_PER_PERSISTENCE_CALL,
    );
    const validRecords = [];
    let validationFailure = null;

    for (const message of messageChunk) {
      const offset = message && message.offset;
      const kafkaOffset = parseKafkaOffset(offset);
      if (kafkaOffset === null) {
        validationFailure = failureResult(
          partition,
          offset,
          "invalid-kafka-offset",
        );
        break;
      }
      if (previousOffset !== null && kafkaOffset <= previousOffset) {
        validationFailure = failureResult(
          partition,
          offset,
          "non-increasing-kafka-offset",
        );
        break;
      }
      previousOffset = kafkaOffset;
      if (kafkaOffset === MAX_KAFKA_OFFSET) {
        validationFailure = failureResult(
          partition,
          offset,
          "next-kafka-offset-out-of-range",
        );
        break;
      }

      let envelope;
      try {
        envelope = parseEnvelope(decodeMessageValue(message.value));
      } catch (error) {
        validationFailure = failureResult(
          partition,
          offset,
          error instanceof SyntaxError ? "malformed-json" : "invalid-envelope",
          error,
        );
        break;
      }

      let expectedPartition;
      try {
        expectedPartition = partitionForSymbol(envelope.symbol, PARTITION_COUNT);
      } catch (error) {
        validationFailure = failureResult(
          partition,
          offset,
          "invalid-event-routing",
          error,
        );
        break;
      }
      if (expectedPartition !== partition) {
        validationFailure = failureResult(
          partition,
          offset,
          "partition-routing-violation",
        );
        break;
      }

      validRecords.push({
        partition,
        offset,
        kafkaOffset,
        envelope,
        eventIdentity: serializeSourceIdentity(envelope.source),
      });
    }

    if (validRecords.length > 0) {
      let persistenceResult;
      try {
        persistenceResult = await persistBatch(
          validRecords.map((record) => record.envelope),
        );
      } catch (error) {
        result.failure = persistenceFailure(
          validRecords[0],
          "persistence-batch-failed",
          error,
        );
        prefixOpen = false;
        continue;
      }

      const statuses = persistenceResult && persistenceResult.results;
      const aligned = Array.isArray(statuses) &&
        statuses.length === validRecords.length &&
        statuses.every((item, index) =>
          item && item.index === index &&
          ["inserted", "replay", "failed"].includes(item.status));
      if (!aligned) {
        result.failure = persistenceFailure(
          validRecords[0],
          "invalid-persistence-batch-result",
        );
        prefixOpen = false;
        continue;
      }

      for (let index = 0; index < validRecords.length; index += 1) {
        const record = validRecords[index];
        const status = statuses[index].status;
        if (status === "failed") {
          if (prefixOpen) {
            result.failure = persistenceFailure(
              record,
              "persistence-failed",
              statuses[index].error,
            );
            prefixOpen = false;
          }
          continue;
        }

        const eventIdentity = statuses[index].eventIdentity;
        if (typeof eventIdentity !== "string") {
          if (prefixOpen) {
            result.failure = persistenceFailure(
              record,
              "missing-persistence-identity",
            );
            prefixOpen = false;
          }
          continue;
        }
        if (eventIdentity !== record.eventIdentity) {
          if (prefixOpen) {
            result.failure = persistenceFailure(
              record,
              "persistence-identity-mismatch",
            );
            prefixOpen = false;
          }
          continue;
        }

        if (prefixOpen) {
          appendCommittable(result, record, status);
        } else {
          result.persistedAfterFailure.push({ offset: record.offset, status });
        }
      }
    }

    if (validationFailure) {
      if (prefixOpen) result.failure = validationFailure;
      prefixOpen = false;
    }
  }

  return result;
}

module.exports = {
  MAX_MESSAGES_PER_PERSISTENCE_CALL,
  V2_TOPIC,
  processHistoryPartitionBatch,
};
