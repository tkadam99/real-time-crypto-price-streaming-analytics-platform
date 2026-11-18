const { parseEnvelope, serializeSourceIdentity } = require("../v2/eventContract");
const { transformV1Record } = require("../v2/relayTransform");

const sourceClusterId = "legacy-cluster";
const sourceTopicGenerationId = "crypto-prices-generation-1";
const sourceRecord = {
  topic: "crypto-prices",
  partition: 2,
  offset: "9007199254740993",
  value: Buffer.from(JSON.stringify({
    symbol: "BTC-USD",
    price: 105.5,
    timestamp: "2026-01-01T00:01:00+00:00",
  })),
};

test.each([
  ["BTC-USD", 0],
  ["ETH-USD", 1],
  ["SOL-USD", 2],
])("transforms %s to its fixed V2 partition", (symbol, expectedPartition) => {
  const record = {
    ...sourceRecord,
    value: JSON.stringify({
      symbol,
      price: 105.5,
      timestamp: "2026-01-01T00:01:00+00:00",
    }),
  };
  const output = transformV1Record(
    record, sourceClusterId, sourceTopicGenerationId, 6,
  );

  expect(output.key).toEqual(Buffer.from(symbol, "utf8"));
  expect(output.partition).toBe(expectedPartition);
  expect(parseEnvelope(output.value).symbol).toBe(symbol);
});

test("preserves the original source identity and exact offset string", () => {
  const output = transformV1Record(
    sourceRecord, sourceClusterId, sourceTopicGenerationId, 6,
  );
  const envelope = parseEnvelope(output.value);
  const expectedSource = {
    clusterId: sourceClusterId,
    topicGenerationId: sourceTopicGenerationId,
    topic: sourceRecord.topic,
    partition: sourceRecord.partition,
    offset: sourceRecord.offset,
  };

  expect(envelope.source).toEqual(expectedSource);
  expect(envelope.source.offset).toBe("9007199254740993");
  expect(serializeSourceIdentity(envelope.source))
    .toBe(serializeSourceIdentity(expectedSource));
});

test("rejects malformed JSON", () => {
  const record = {
    ...sourceRecord,
    value: Buffer.from("{"),
  };

  expect(() => transformV1Record(
    record, sourceClusterId, sourceTopicGenerationId, 6,
  )).toThrow(SyntaxError);
});

test("rejects unsupported symbols", () => {
  const record = {
    ...sourceRecord,
    value: JSON.stringify({
      symbol: "DOGE-USD",
      price: 105.5,
      timestamp: "2026-01-01T00:01:00+00:00",
    }),
  };

  expect(() => transformV1Record(
    record, sourceClusterId, sourceTopicGenerationId, 6,
  )).toThrow("Invalid event symbol.");
});

test.each([1, "01", "-1", "9223372036854775808", Number.MAX_SAFE_INTEGER + 2])(
  "rejects invalid source offset %p",
  (offset) => {
    const record = { ...sourceRecord, offset };

    expect(() => transformV1Record(
      record, sourceClusterId, sourceTopicGenerationId, 6,
    )).toThrow("Invalid source offset.");
  },
);

test.each([5, 7])("rejects incorrect V2 partition count %i", (partitionCount) => {
  expect(() => transformV1Record(
    sourceRecord, sourceClusterId, sourceTopicGenerationId, partitionCount,
  )).toThrow("Partitioning version 1 requires exactly six partitions.");
});
