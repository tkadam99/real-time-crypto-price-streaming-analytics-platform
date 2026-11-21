const {
  createEnvelope,
  serializeEnvelope,
  parseEnvelope,
  serializeSourceIdentity,
  parseSourceIdentity,
  partitionForSymbol,
} = require("../v2/eventContract");

const event = { symbol: "BTC-USD", price: 105.5, timestamp: "2026-01-01T00:01:00+00:00" };
const source = {
  clusterId: "cluster-a",
  topicGenerationId: "generation-1",
  topic: "crypto-prices",
  partition: 0,
  offset: "9007199254740993",
};

test("round-trips an envelope and source identity without losing the original event or offset", () => {
  const envelope = createEnvelope(event, source);
  expect(parseEnvelope(serializeEnvelope(envelope))).toEqual({
    version: 1, ...event, source,
  });
  expect(parseSourceIdentity(serializeSourceIdentity(source))).toEqual(source);
  expect(envelope.source.offset).toBe("9007199254740993");
});

test("source identities distinguish every component and delimiter-like content", () => {
  const variants = [
    source,
    { ...source, clusterId: "cluster-b" },
    { ...source, topicGenerationId: "generation-2" },
    { ...source, topic: "other-topic" },
    { ...source, partition: 1 },
    { ...source, offset: "9007199254740994" },
    { ...source, clusterId: 'a","b', topicGenerationId: "c" },
    { ...source, clusterId: "a", topicGenerationId: 'b","c' },
  ];
  const identities = variants.map(serializeSourceIdentity);
  expect(new Set(identities).size).toBe(variants.length);
  expect(identities.map(parseSourceIdentity)).toEqual(variants);
});

test("accepts the largest signed 64-bit Kafka offset exactly", () => {
  const maximum = { ...source, offset: "9223372036854775807" };
  expect(parseSourceIdentity(serializeSourceIdentity(maximum))).toEqual(maximum);
  expect(parseEnvelope(serializeEnvelope(createEnvelope(event, maximum))).source.offset)
    .toBe(maximum.offset);
});

test.each([
  null, [], {}, { ...event, symbol: "DOGE-USD" }, { ...event, symbol: "" },
  { ...event, price: "100" }, { ...event, price: 0 }, { ...event, price: -1 },
  { ...event, price: NaN }, { ...event, price: Infinity },
  { ...event, timestamp: "" }, { ...event, timestamp: "not a timestamp" },
])("rejects invalid event input: %p", (invalid) => {
  expect(() => createEnvelope(invalid, source)).toThrow();
});

test.each([
  null, [], { ...source, clusterId: "" }, { ...source, topicGenerationId: " " },
  { ...source, topic: null }, { ...source, partition: -1 },
  { ...source, partition: 1.5 }, { ...source, partition: 2147483648 },
  { ...source, offset: 1 }, { ...source, offset: "-1" }, { ...source, offset: "01" },
  { ...source, offset: "1\n" },
  { ...source, offset: "" }, { ...source, offset: "9223372036854775808" },
])("rejects invalid source identity: %p", (invalid) => {
  expect(() => createEnvelope(event, invalid)).toThrow();
  expect(() => serializeSourceIdentity(invalid)).toThrow();
});

test("rejects malformed or unsupported serialized contracts", () => {
  expect(() => parseEnvelope("{")).toThrow();
  expect(() => parseEnvelope(JSON.stringify({ ...createEnvelope(event, source), version: 2 }))).toThrow();
  expect(() => serializeEnvelope({ ...createEnvelope(event, source), price: 0 })).toThrow();
  expect(() => parseSourceIdentity('["cluster","generation","topic",0,9007199254740993]')).toThrow();
  expect(() => parseSourceIdentity('["cluster","generation","topic",0]')).toThrow();
});

test.each([
  ["BTC-USD", 0],
  ["ETH-USD", 1],
  ["SOL-USD", 2],
])("maps %s deterministically using partitioning version 1", (symbol, expected) => {
  expect(partitionForSymbol(symbol, 6)).toBe(expected);
  expect(partitionForSymbol(symbol, 6)).toBe(expected);
});

test("rejects unsupported symbols and partition counts", () => {
  expect(() => partitionForSymbol("DOGE-USD", 6)).toThrow();
  expect(() => partitionForSymbol("BTC-USD", 5)).toThrow();
  expect(() => partitionForSymbol("BTC-USD", 7)).toThrow();
  expect(() => partitionForSymbol("BTC-USD")).toThrow();
});
