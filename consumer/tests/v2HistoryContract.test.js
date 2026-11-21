const {
  createEnvelope,
  serializeSourceIdentity,
} = require("../v2/eventContract");
const {
  createHistoryDocuments,
  deriveEventIdentity,
} = require("../v2/historyContract");

const event = {
  symbol: "BTC-USD",
  price: 105.5,
  timestamp: "2026-01-01T00:01:00+00:00",
};
const source = {
  clusterId: "cluster-a",
  topicGenerationId: "generation-1",
  topic: "crypto-prices",
  partition: 0,
  offset: "9007199254740993",
};
const insertedAt = new Date("2026-01-02T03:04:05.000Z");

function envelope(eventValue = event, sourceValue = source) {
  return createEnvelope(eventValue, sourceValue);
}

test("creates separate history and durable receipt documents with one identity", () => {
  const documents = createHistoryDocuments(envelope(), insertedAt);
  const eventIdentity = serializeSourceIdentity(source);

  expect(documents.history).toEqual({
    _id: eventIdentity,
    symbol: event.symbol,
    price: event.price,
    timestamp: event.timestamp,
    source,
    createdAt: insertedAt,
  });
  expect(documents.receipt).toEqual({ _id: eventIdentity, source });
  expect(documents.history._id).toBe(documents.receipt._id);
  expect(documents.history.source).not.toBe(documents.receipt.source);
});

test("derives a stable identity from all five validated source fields", () => {
  const validEnvelope = envelope();
  const identities = [
    validEnvelope,
    envelope(event, { ...source, clusterId: "cluster-b" }),
    envelope(event, { ...source, topicGenerationId: "generation-2" }),
    envelope(event, { ...source, topic: "other-topic" }),
    envelope(event, { ...source, partition: 1 }),
    envelope(event, { ...source, offset: "9007199254740994" }),
  ].map(deriveEventIdentity);

  expect(deriveEventIdentity(validEnvelope)).toBe(identities[0]);
  expect(identities[0]).toBe(serializeSourceIdentity(source));
  expect(new Set(identities).size).toBe(identities.length);
});

test("preserves Kafka offsets as exact strings in both documents and identity", () => {
  const documents = createHistoryDocuments(envelope(), insertedAt);

  expect(documents.history.source.offset).toBe("9007199254740993");
  expect(documents.receipt.source.offset).toBe("9007199254740993");
  expect(documents.history._id).toContain('"9007199254740993"');
});

test.each([
  null,
  { ...event, version: 2 },
  { ...envelope(), price: 0 },
  { ...envelope(), timestamp: "invalid timestamp" },
  { ...envelope(), source: { ...source, offset: "01" } },
])("rejects malformed or invalid envelopes: %p", (invalidEnvelope) => {
  expect(() => createHistoryDocuments(invalidEnvelope, insertedAt)).toThrow();
  expect(() => deriveEventIdentity(invalidEnvelope)).toThrow();
});

test("keeps insertion time separate from the event timestamp and clones it", () => {
  const documents = createHistoryDocuments(envelope(), insertedAt);

  expect(documents.history.timestamp).toBe(event.timestamp);
  expect(documents.history.createdAt).toEqual(insertedAt);
  expect(documents.history.createdAt).not.toBe(insertedAt);
  expect(documents.history.createdAt.toISOString()).not.toBe(documents.history.timestamp);
  expect(documents.receipt).not.toHaveProperty("createdAt");
});

test("rejects an invalid insertion time", () => {
  expect(() => createHistoryDocuments(envelope(), "2026-01-02T03:04:05.000Z"))
    .toThrow("History insertion time must be a valid Date.");
  expect(() => createHistoryDocuments(envelope(), new Date("invalid")))
    .toThrow("History insertion time must be a valid Date.");
});
