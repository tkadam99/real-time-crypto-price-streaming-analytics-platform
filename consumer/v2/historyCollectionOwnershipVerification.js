const { Collection, Db, MongoClient } = require("mongodb");
const { HISTORY_DATABASE_NAME } = require("./historyConsumerConfig");
const { HISTORY_COLLECTION_NAMES } = require("./historyCollectionInspection");
const {
  matchesExpectedHistoryCollectionOptions,
} = require("./historyCollectionSchema");
const { HISTORY_TTL_SECONDS } = require("./historyIndexes");

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateDependencies({
  database,
  mongoClient,
  historyCollection,
  receiptCollection,
}) {
  if (!(mongoClient instanceof MongoClient) ||
      !(database instanceof Db) ||
      database.databaseName !== HISTORY_DATABASE_NAME ||
      database.client !== mongoClient) {
    throw new Error("V2 history ownership verification requires the approved MongoDB database and client.");
  }

  const collections = [
    [historyCollection, HISTORY_COLLECTION_NAMES.history],
    [receiptCollection, HISTORY_COLLECTION_NAMES.receipts],
  ];
  for (const [collection, expectedName] of collections) {
    if (!(collection instanceof Collection) ||
        collection.collectionName !== expectedName ||
        collection.db !== database ||
        collection.db.client !== mongoClient ||
        typeof collection.listIndexes !== "function") {
      throw new Error("V2 history ownership verification requires collections from the approved MongoDB client and database.");
    }
  }
}

function validateCollectionMetadata(metadata, databaseName) {
  if (!isRecord(metadata) ||
      typeof metadata.name !== "string" ||
      typeof metadata.type !== "string" ||
      !isRecord(metadata.options)) {
    throw new Error("V2 history collection metadata is malformed.");
  }
  if (!Object.values(HISTORY_COLLECTION_NAMES).includes(metadata.name)) {
    throw new Error("V2 history collection metadata contains an unexpected namespace.");
  }

  const expectedNamespace = `${databaseName}.${metadata.name}`;
  for (const field of ["namespace", "ns"]) {
    if (Object.prototype.hasOwnProperty.call(metadata, field) &&
        metadata[field] !== expectedNamespace) {
      throw new Error("V2 history collection metadata contains an unexpected namespace.");
    }
  }
  if (metadata.type !== "collection" ||
      metadata.options.viewOn !== undefined ||
      metadata.options.timeseries !== undefined ||
      metadata.options.capped === true) {
    throw new Error("V2 history collection has an incompatible collection type.");
  }
  if (!matchesExpectedHistoryCollectionOptions(metadata.name, metadata.options)) {
    throw new Error("V2 history collection ownership or schema does not match.");
  }
}

async function readCollectionMetadata(database) {
  let cursor;
  try {
    cursor = database.listCollections(
      { name: { $in: Object.values(HISTORY_COLLECTION_NAMES) } },
      { nameOnly: false },
    );
    if (!cursor || typeof cursor.toArray !== "function") {
      throw new Error("invalid collection metadata cursor");
    }
    const metadata = await cursor.toArray();
    if (!Array.isArray(metadata)) {
      throw new Error("invalid collection metadata");
    }
    return metadata;
  } catch {
    throw new Error("Unable to inspect approved V2 history collection metadata.");
  }
}

function hasTtl(index) {
  return Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds");
}

function exactKey(actual, expected) {
  if (!isRecord(actual)) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length &&
    actualEntries.every(([key, value], index) =>
      key === expectedEntries[index][0] && value === expectedEntries[index][1]);
}

async function readIndexes(collection) {
  try {
    const cursor = collection.listIndexes();
    if (!cursor || typeof cursor.toArray !== "function") {
      throw new Error("invalid index cursor");
    }
    const indexes = await cursor.toArray();
    if (!Array.isArray(indexes) ||
        indexes.some((index) =>
          !isRecord(index) || typeof index.name !== "string" || !isRecord(index.key))) {
      throw new Error("invalid index metadata");
    }
    return indexes;
  } catch {
    throw new Error("Unable to inspect V2 history collection indexes.");
  }
}

function verifyIdIndex(indexes, label) {
  const idIndex = indexes.find((index) => index.name === "_id_");
  if (!idIndex ||
      !exactKey(idIndex.key, { _id: 1 }) ||
      idIndex.unique === false) {
    throw new Error(`V2 history ${label} collection has an incompatible _id_ index.`);
  }
}

function verifyHistoryIndexes(indexes) {
  verifyIdIndex(indexes, "history");
  const ttlIndexes = indexes.filter(hasTtl);
  const createdAtIndexes = indexes.filter((index) =>
    Object.prototype.hasOwnProperty.call(index.key, "createdAt"),
  );
  if (ttlIndexes.length > 1 || createdAtIndexes.length > 1) {
    throw new Error("V2 history collection has conflicting TTL indexes.");
  }
  if (ttlIndexes.length === 0 && createdAtIndexes.length === 0) {
    return false;
  }

  const index = ttlIndexes[0] || createdAtIndexes[0];
  const supportedFields = new Set([
    "v",
    "key",
    "name",
    "ns",
    "expireAfterSeconds",
  ]);
  if (!exactKey(index.key, { createdAt: 1 }) ||
      index.expireAfterSeconds !== HISTORY_TTL_SECONDS ||
      Object.keys(index).some((field) => !supportedFields.has(field))) {
    throw new Error("V2 history collection has an incompatible createdAt index.");
  }
  return true;
}

function verifyReceiptIndexes(indexes) {
  verifyIdIndex(indexes, "receipt");
  if (indexes.some(hasTtl)) {
    throw new Error("V2 history receipt collection must not have a TTL index.");
  }
}

async function verifyHistoryCollectionOwnership({
  database,
  mongoClient,
  historyCollection,
  receiptCollection,
}) {
  validateDependencies({
    database,
    mongoClient,
    historyCollection,
    receiptCollection,
  });

  const metadata = await readCollectionMetadata(database);
  const byName = new Map();
  for (const collection of metadata) {
    validateCollectionMetadata(collection, database.databaseName);
    if (byName.has(collection.name)) {
      throw new Error("V2 history collection metadata contains duplicate names.");
    }
    byName.set(collection.name, collection);
  }
  for (const name of Object.values(HISTORY_COLLECTION_NAMES)) {
    if (!byName.has(name)) {
      throw new Error("An approved V2 history collection is missing.");
    }
  }

  const historyIndexes = await readIndexes(historyCollection);
  const receiptIndexes = await readIndexes(receiptCollection);
  const historyTtlPresent = verifyHistoryIndexes(historyIndexes);
  verifyReceiptIndexes(receiptIndexes);

  return Object.freeze({
    databaseName: HISTORY_DATABASE_NAME,
    status: "verified",
    collections: Object.freeze({
      history: HISTORY_COLLECTION_NAMES.history,
      receipts: HISTORY_COLLECTION_NAMES.receipts,
    }),
    indexes: Object.freeze({
      historyTtl: historyTtlPresent ? "verified" : "pending-setup",
      receiptsTtl: "absent",
    }),
  });
}

module.exports = {
  verifyHistoryCollectionOwnership,
};
