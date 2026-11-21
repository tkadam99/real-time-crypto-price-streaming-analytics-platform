const {
  createEnvelope,
  serializeEnvelope,
  partitionForSymbol,
} = require("./eventContract");

function transformV1Record(record, clusterId, topicGenerationId, partitionCount) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Invalid V1 Kafka record.");
  }
  const { value } = record;
  let serializedEvent;
  if (Buffer.isBuffer(value)) {
    serializedEvent = value.toString("utf8");
  } else if (typeof value === "string") {
    serializedEvent = value;
  } else {
    throw new Error("Invalid V1 Kafka message value.");
  }

  const event = JSON.parse(serializedEvent);
  const envelope = createEnvelope(event, {
    clusterId,
    topicGenerationId,
    topic: record.topic,
    partition: record.partition,
    offset: record.offset,
  });
  const partition = partitionForSymbol(envelope.symbol, partitionCount);

  return {
    key: Buffer.from(envelope.symbol, "utf8"),
    partition,
    value: serializeEnvelope(envelope),
  };
}

module.exports = { transformV1Record };
