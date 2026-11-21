const { HISTORY_DATABASE_NAME } = require("./historyConsumerConfig");

const HISTORY_SCHEMA_VERSION = 1;
const HISTORY_COLLECTION_OWNERSHIP_IDS = Object.freeze({
  history: `${HISTORY_DATABASE_NAME}.price_history:crypto-v2-history:v${HISTORY_SCHEMA_VERSION}`,
  receipts: `${HISTORY_DATABASE_NAME}.replay_receipts:crypto-v2-history:v${HISTORY_SCHEMA_VERSION}`,
});
const HISTORY_SYMBOLS = Object.freeze(["BTC-USD", "ETH-USD", "SOL-USD"]);
const MAX_SOURCE_OFFSET = "9223372036854775807";
const SOURCE_FIELDS = Object.freeze([
  "clusterId",
  "topicGenerationId",
  "topic",
  "partition",
  "offset",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, clone(child)]),
    );
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stringField() {
  return { bsonType: "string", minLength: 1 };
}

function fixedWidthIntegerRangePattern(maximum) {
  const alternatives = [];
  let prefix = "";
  for (let index = 0; index < maximum.length; index += 1) {
    const maximumDigit = Number(maximum[index]);
    const minimumDigit = index === 0 ? 1 : 0;
    if (maximumDigit > minimumDigit) {
      const digitRange = minimumDigit === maximumDigit - 1
        ? String(minimumDigit)
        : `[${minimumDigit}-${maximumDigit - 1}]`;
      const remainingDigits = maximum.length - index - 1;
      alternatives.push(
        `${prefix}${digitRange}${remainingDigits ? `[0-9]{${remainingDigits}}` : ""}`,
      );
    }
    prefix += maximum[index];
  }
  alternatives.push(prefix);
  return alternatives.join("|");
}

const SOURCE_OFFSET_PATTERN =
  `^(?:0|[1-9][0-9]{0,17}|${fixedWidthIntegerRangePattern(MAX_SOURCE_OFFSET)})$`;

const sourceSchema = deepFreeze({
  bsonType: "object",
  required: SOURCE_FIELDS,
  additionalProperties: false,
  properties: {
    clusterId: stringField(),
    topicGenerationId: stringField(),
    topic: stringField(),
    partition: { bsonType: "int", minimum: 0, maximum: 2147483647 },
    offset: {
      bsonType: "string",
      minLength: 1,
      maxLength: 19,
      pattern: SOURCE_OFFSET_PATTERN,
    },
  },
});

const COLLECTION_SCHEMAS = deepFreeze({
  history: {
    title: HISTORY_COLLECTION_OWNERSHIP_IDS.history,
    bsonType: "object",
    required: [
      "_id",
      "symbol",
      "price",
      "timestamp",
      "source",
      "createdAt",
    ],
    additionalProperties: false,
    properties: {
      _id: { bsonType: "string" },
      symbol: { bsonType: "string", enum: HISTORY_SYMBOLS },
      price: {
        bsonType: ["double", "int", "long", "decimal"],
        minimum: 0,
        exclusiveMinimum: true,
      },
      timestamp: stringField(),
      source: sourceSchema,
      createdAt: { bsonType: "date" },
    },
  },
  receipts: {
    title: HISTORY_COLLECTION_OWNERSHIP_IDS.receipts,
    bsonType: "object",
    required: ["_id", "source"],
    additionalProperties: false,
    properties: {
      _id: { bsonType: "string" },
      source: sourceSchema,
    },
  },
});

function collectionRole(collectionName) {
  if (collectionName === "price_history") return "history";
  if (collectionName === "replay_receipts") return "receipts";
  throw new Error("Unknown V2 history collection name.");
}

function expectedHistoryCollectionOptions(collectionName) {
  const role = collectionRole(collectionName);
  return {
    validator: {
      $jsonSchema: clone(COLLECTION_SCHEMAS[role]),
    },
    validationLevel: "strict",
    validationAction: "error",
  };
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqual(left[key], right[key]));
}

function matchesExpectedHistoryCollectionOptions(collectionName, observedOptions) {
  if (!isPlainObject(observedOptions)) return false;
  let expectedOptions;
  try {
    expectedOptions = expectedHistoryCollectionOptions(collectionName);
  } catch {
    return false;
  }
  return deepEqual(observedOptions, expectedOptions);
}

module.exports = {
  HISTORY_COLLECTION_OWNERSHIP_IDS,
  HISTORY_SCHEMA_VERSION,
  expectedHistoryCollectionOptions,
  matchesExpectedHistoryCollectionOptions,
};
