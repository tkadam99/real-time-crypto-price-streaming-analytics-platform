const {
  createEnvelope,
} = require("../v2/eventContract");
const { createHistoryDocuments } = require("../v2/historyContract");
const { HISTORY_DATABASE_NAME } = require("../v2/historyConsumerConfig");
const {
  HISTORY_COLLECTION_OWNERSHIP_IDS,
  HISTORY_SCHEMA_VERSION,
  expectedHistoryCollectionOptions,
  matchesExpectedHistoryCollectionOptions,
} = require("../v2/historyCollectionSchema");

const source = {
  clusterId: "cluster-a",
  topicGenerationId: "generation-1",
  topic: "crypto-prices",
  partition: 0,
  offset: "9007199254740993",
};
const envelope = createEnvelope({
  symbol: "BTC-USD",
  price: 105.5,
  timestamp: "2026-01-01T00:01:00+00:00",
}, source);
const documents = createHistoryDocuments(envelope, new Date("2026-01-02T03:04:05.000Z"));

function bsonTypeMatches(type, value) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" &&
        !Array.isArray(value) && !(value instanceof Date);
    case "string":
      return typeof value === "string";
    case "date":
      return value instanceof Date && Number.isFinite(value.getTime());
    case "int":
      return Number.isInteger(value);
    case "double":
    case "long":
    case "decimal":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return false;
  }
}

function matchesSchema(schema, document) {
  const types = Array.isArray(schema.bsonType) ? schema.bsonType : [schema.bsonType];
  if (!types.some((type) => bsonTypeMatches(type, document))) return false;

  if (schema.required &&
      schema.required.some((field) =>
        !Object.prototype.hasOwnProperty.call(document, field))) {
    return false;
  }
  if (schema.additionalProperties === false &&
      Object.keys(document).some((field) =>
        !Object.prototype.hasOwnProperty.call(schema.properties, field))) {
    return false;
  }

  for (const [field, fieldSchema] of Object.entries(schema.properties || {})) {
    if (!Object.prototype.hasOwnProperty.call(document, field)) continue;
    const value = document[field];
    const fieldTypes = Array.isArray(fieldSchema.bsonType)
      ? fieldSchema.bsonType
      : [fieldSchema.bsonType];
    if (!fieldTypes.some((type) => bsonTypeMatches(type, value))) return false;
    if (fieldSchema.enum && !fieldSchema.enum.includes(value)) return false;
    if (fieldSchema.minLength !== undefined &&
        value.length < fieldSchema.minLength) return false;
    if (fieldSchema.maxLength !== undefined &&
        value.length > fieldSchema.maxLength) return false;
    if (fieldSchema.pattern && !new RegExp(fieldSchema.pattern).test(value)) return false;
    if (fieldSchema.minimum !== undefined &&
        (value < fieldSchema.minimum ||
          (fieldSchema.exclusiveMinimum === true &&
            value === fieldSchema.minimum))) return false;
    if (fieldSchema.maximum !== undefined && value > fieldSchema.maximum) return false;
    if (fieldSchema.properties && !matchesSchema(fieldSchema, value)) return false;
  }
  return true;
}

function mutableExpectedOptions(collectionName) {
  return JSON.parse(JSON.stringify(expectedHistoryCollectionOptions(collectionName)));
}

test("defines versioned ownership identifiers for only the approved collections", () => {
  expect(HISTORY_SCHEMA_VERSION).toBe(1);
  expect(HISTORY_COLLECTION_OWNERSHIP_IDS).toEqual({
    history: `${HISTORY_DATABASE_NAME}.price_history:crypto-v2-history:v1`,
    receipts: `${HISTORY_DATABASE_NAME}.replay_receipts:crypto-v2-history:v1`,
  });
  expect(() => expectedHistoryCollectionOptions("other_collection"))
    .toThrow("Unknown V2 history collection name.");
});

test.each([
  ["price_history", documents.history],
  ["replay_receipts", documents.receipt],
])("%s validator accepts the actual historyContract document shape", (name, document) => {
  const schema = expectedHistoryCollectionOptions(name).validator.$jsonSchema;

  expect(matchesSchema(schema, document)).toBe(true);
  expect(schema.additionalProperties).toBe(false);
  expect(expectedHistoryCollectionOptions(name)).toMatchObject({
    validationLevel: "strict",
    validationAction: "error",
  });
});

test("history schema preserves numeric prices, date insertion times, and string offsets", () => {
  const options = expectedHistoryCollectionOptions("price_history");
  const schema = options.validator.$jsonSchema;

  expect(schema.properties.price.bsonType).toEqual([
    "double",
    "int",
    "long",
    "decimal",
  ]);
  expect(schema.properties.timestamp.bsonType).toBe("string");
  expect(schema.properties.createdAt.bsonType).toBe("date");
  expect(schema.properties.source.properties.offset).toMatchObject({
    bsonType: "string",
    maxLength: 19,
  });
  const offsetPattern = new RegExp(
    schema.properties.source.properties.offset.pattern,
  );
  expect(offsetPattern.test("9223372036854775807")).toBe(true);
  expect(offsetPattern.test("9223372036854775808")).toBe(false);
  expect(offsetPattern.test("01")).toBe(false);
  expect(typeof documents.history.source.offset).toBe("string");
});

test("source partition schema covers the range allowed by the event contract", () => {
  const maximumPartitionEnvelope = createEnvelope({
    symbol: "BTC-USD",
    price: 105.5,
    timestamp: "2026-01-01T00:01:00+00:00",
  }, {
    ...source,
    partition: 2147483647,
  });
  const maximumPartitionDocuments = createHistoryDocuments(
    maximumPartitionEnvelope,
    new Date("2026-01-02T03:04:05.000Z"),
  );
  const historySchema =
    expectedHistoryCollectionOptions("price_history").validator.$jsonSchema;

  expect(matchesSchema(historySchema, maximumPartitionDocuments.history)).toBe(true);
});

test("rejects malformed document values and extra fields in the offline schema shape", () => {
  const historySchema =
    expectedHistoryCollectionOptions("price_history").validator.$jsonSchema;
  const receiptSchema =
    expectedHistoryCollectionOptions("replay_receipts").validator.$jsonSchema;

  expect(matchesSchema(historySchema, {
    ...documents.history,
    price: "105.5",
  })).toBe(false);
  expect(matchesSchema(historySchema, {
    ...documents.history,
    createdAt: documents.history.timestamp,
  })).toBe(false);
  expect(matchesSchema(historySchema, {
    ...documents.history,
    source: { ...documents.history.source, offset: 9007199254740993 },
  })).toBe(false);
  expect(matchesSchema(receiptSchema, {
    ...documents.receipt,
    createdAt: documents.history.createdAt,
  })).toBe(false);
});

test.each([
  ["missing options", undefined],
  ["missing validator", { validationLevel: "strict", validationAction: "error" }],
  ["missing ownership marker", (() => {
    const options = mutableExpectedOptions("price_history");
    delete options.validator.$jsonSchema.title;
    return options;
  })()],
  ["wrong schema version", (() => {
    const options = mutableExpectedOptions("price_history");
    options.validator.$jsonSchema.title = "crypto_analytics_v2.price_history:crypto-v2-history:v2";
    return options;
  })()],
  ["wrong validator field", (() => {
    const options = mutableExpectedOptions("price_history");
    options.validator.$jsonSchema.properties.createdAt.bsonType = "string";
    return options;
  })()],
  ["wrong validation level", (() => {
    const options = mutableExpectedOptions("price_history");
    options.validationLevel = "moderate";
    return options;
  })()],
  ["wrong validation action", (() => {
    const options = mutableExpectedOptions("price_history");
    options.validationAction = "warn";
    return options;
  })()],
  ["incompatible collection option", (() => {
    const options = mutableExpectedOptions("price_history");
    options.capped = true;
    return options;
  })()],
])("fails closed for %s", (_label, observedOptions) => {
  expect(matchesExpectedHistoryCollectionOptions("price_history", observedOptions))
    .toBe(false);
});

test("compares the complete expected options for each role without sharing mutable state", () => {
  for (const name of ["price_history", "replay_receipts"]) {
    const options = expectedHistoryCollectionOptions(name);
    expect(matchesExpectedHistoryCollectionOptions(name, options)).toBe(true);
    options.validator.$jsonSchema.title = "modified";
    expect(matchesExpectedHistoryCollectionOptions(name, options)).toBe(false);
    expect(matchesExpectedHistoryCollectionOptions(
      name,
      expectedHistoryCollectionOptions(name),
    )).toBe(true);
  }
  expect(matchesExpectedHistoryCollectionOptions("unexpected", {})).toBe(false);
});
