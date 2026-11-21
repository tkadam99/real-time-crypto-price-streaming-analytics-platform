const VERSION = 1;
const PARTITION_COUNT = 6;
const SYMBOL_PARTITIONS_V1 = Object.freeze({
  "BTC-USD": 0,
  "ETH-USD": 1,
  "SOL-USD": 2,
});
const SYMBOLS = new Set(Object.keys(SYMBOL_PARTITIONS_V1));
const MAX_OFFSET = "9223372036854775807";
const MAX_PARTITION = 2147483647;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateSource(source) {
  if (!isObject(source)) throw new Error("Invalid source identity.");
  for (const field of ["clusterId", "topicGenerationId", "topic"]) {
    if (typeof source[field] !== "string" || source[field].trim() === "") {
      throw new Error(`Invalid source ${field}.`);
    }
  }
  if (!Number.isInteger(source.partition) || source.partition < 0 || source.partition > MAX_PARTITION) {
    throw new Error("Invalid source partition.");
  }
  const { offset } = source;
  if (typeof offset !== "string" || !/^(0|[1-9][0-9]*)(?![\s\S])/.test(offset) ||
      offset.length > MAX_OFFSET.length ||
      (offset.length === MAX_OFFSET.length && offset > MAX_OFFSET)) {
    throw new Error("Invalid source offset.");
  }
}

function validateEnvelope(envelope) {
  if (!isObject(envelope) || envelope.version !== VERSION) {
    throw new Error("Invalid event envelope version.");
  }
  if (!SYMBOLS.has(envelope.symbol)) throw new Error("Invalid event symbol.");
  if (typeof envelope.price !== "number" || !Number.isFinite(envelope.price) || envelope.price <= 0) {
    throw new Error("Invalid event price.");
  }
  if (typeof envelope.timestamp !== "string" || envelope.timestamp.trim() === "" ||
      !Number.isFinite(Date.parse(envelope.timestamp))) {
    throw new Error("Invalid event timestamp.");
  }
  validateSource(envelope.source);
}

function createEnvelope(event, source) {
  if (!isObject(event)) throw new Error("Invalid event.");
  validateSource(source);
  const envelope = {
    version: VERSION,
    symbol: event.symbol,
    price: event.price,
    timestamp: event.timestamp,
    source: {
      clusterId: source.clusterId,
      topicGenerationId: source.topicGenerationId,
      topic: source.topic,
      partition: source.partition,
      offset: source.offset,
    },
  };
  validateEnvelope(envelope);
  return envelope;
}

function serializeEnvelope(envelope) {
  validateEnvelope(envelope);
  return JSON.stringify(envelope);
}

function parseEnvelope(serialized) {
  if (typeof serialized !== "string") throw new Error("Event envelope must be a JSON string.");
  const envelope = JSON.parse(serialized);
  validateEnvelope(envelope);
  return envelope;
}

function serializeSourceIdentity(source) {
  validateSource(source);
  return JSON.stringify([
    source.clusterId, source.topicGenerationId, source.topic, source.partition, source.offset,
  ]);
}

function parseSourceIdentity(serialized) {
  if (typeof serialized !== "string") throw new Error("Source identity must be a JSON string.");
  const fields = JSON.parse(serialized);
  if (!Array.isArray(fields) || fields.length !== 5) throw new Error("Invalid source identity.");
  const [clusterId, topicGenerationId, topic, partition, offset] = fields;
  const source = { clusterId, topicGenerationId, topic, partition, offset };
  validateSource(source);
  return source;
}

function partitionForSymbol(symbol, partitionCount) {
  if (!Object.prototype.hasOwnProperty.call(SYMBOL_PARTITIONS_V1, symbol)) {
    throw new Error("Invalid event symbol.");
  }
  if (partitionCount !== PARTITION_COUNT) {
    throw new Error("Partitioning version 1 requires exactly six partitions.");
  }
  return SYMBOL_PARTITIONS_V1[symbol];
}

module.exports = {
  createEnvelope,
  serializeEnvelope,
  parseEnvelope,
  serializeSourceIdentity,
  parseSourceIdentity,
  partitionForSymbol,
};
