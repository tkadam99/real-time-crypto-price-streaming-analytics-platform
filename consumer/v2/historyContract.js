const {
  parseEnvelope,
  serializeEnvelope,
  serializeSourceIdentity,
} = require("./eventContract");

function validatedEnvelope(envelope) {
  return parseEnvelope(serializeEnvelope(envelope));
}

function copySource(source) {
  return {
    clusterId: source.clusterId,
    topicGenerationId: source.topicGenerationId,
    topic: source.topic,
    partition: source.partition,
    offset: source.offset,
  };
}

function validateInsertionTime(insertedAt) {
  if (!(insertedAt instanceof Date) || !Number.isFinite(insertedAt.getTime())) {
    throw new Error("History insertion time must be a valid Date.");
  }
  return new Date(insertedAt.getTime());
}

function deriveEventIdentity(envelope) {
  const validated = validatedEnvelope(envelope);
  return serializeSourceIdentity(validated.source);
}

function createHistoryDocuments(envelope, insertedAt) {
  const validated = validatedEnvelope(envelope);
  const createdAt = validateInsertionTime(insertedAt);
  const eventIdentity = serializeSourceIdentity(validated.source);
  const source = copySource(validated.source);

  return {
    history: {
      _id: eventIdentity,
      symbol: validated.symbol,
      price: validated.price,
      timestamp: validated.timestamp,
      source,
      createdAt,
    },
    receipt: {
      _id: eventIdentity,
      source: copySource(validated.source),
    },
  };
}

module.exports = {
  createHistoryDocuments,
  deriveEventIdentity,
};
