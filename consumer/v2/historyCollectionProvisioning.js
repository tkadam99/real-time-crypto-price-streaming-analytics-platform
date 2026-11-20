const {
  HISTORY_DATABASE_NAME,
  HISTORY_MONGO_MEMBER,
  HISTORY_MONGO_URI,
  HISTORY_REPLICA_SET_NAME,
} = require("./historyConsumerConfig");
const {
  HISTORY_COLLECTION_NAMES,
} = require("./historyCollectionInspection");
const {
  expectedHistoryCollectionOptions,
  matchesExpectedHistoryCollectionOptions,
} = require("./historyCollectionSchema");
const { verifyHistoryMongoIdentity } = require("./historyConsumerPreflight");
const {
  ensureHistoryIndexes,
  HISTORY_TTL_SECONDS,
} = require("./historyIndexes");

const HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT =
  "I_ACKNOWLEDGE_V2_HISTORY_COLLECTION_PROVISIONING";
const HISTORY_IDENTITY_CONFIG = Object.freeze({
  mongo: Object.freeze({
    uri: HISTORY_MONGO_URI,
    databaseName: HISTORY_DATABASE_NAME,
    replicaSetName: HISTORY_REPLICA_SET_NAME,
    member: HISTORY_MONGO_MEMBER,
  }),
});

function validateDependencies({
  database,
  mongoClient,
  provisionAcknowledgement,
}) {
  if (provisionAcknowledgement !== HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT) {
    throw new Error("V2 history collection provisioning acknowledgement is required.");
  }
  if (!database || database.databaseName !== HISTORY_DATABASE_NAME ||
      database.client !== mongoClient ||
      typeof database.listCollections !== "function" ||
      typeof database.createCollection !== "function" ||
      typeof database.collection !== "function") {
    throw new Error("V2 history provisioning requires the approved MongoDB database.");
  }
  if (!mongoClient || typeof mongoClient.db !== "function") {
    throw new Error("V2 history provisioning requires an injected MongoDB client.");
  }
}

function validateCollectionMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
      typeof metadata.name !== "string" ||
      !Object.values(HISTORY_COLLECTION_NAMES).includes(metadata.name) ||
      metadata.type !== "collection" ||
      !metadata.options ||
      typeof metadata.options !== "object" ||
      Array.isArray(metadata.options)) {
    throw new Error("V2 history collection metadata is missing or incompatible.");
  }
  const expectedNamespace = `${HISTORY_DATABASE_NAME}.${metadata.name}`;
  if ((metadata.namespace !== undefined &&
        metadata.namespace !== expectedNamespace) ||
      (metadata.ns !== undefined && metadata.ns !== expectedNamespace) ||
      !matchesExpectedHistoryCollectionOptions(metadata.name, metadata.options)) {
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
  } catch {
    throw new Error("Unable to inspect V2 history collections.");
  }
  if (!cursor || typeof cursor.toArray !== "function") {
    throw new Error("Unable to inspect V2 history collections.");
  }

  let metadata;
  try {
    metadata = await cursor.toArray();
  } catch {
    throw new Error("Unable to inspect V2 history collections.");
  }
  if (!Array.isArray(metadata)) {
    throw new Error("V2 history collection metadata is malformed.");
  }

  const byName = new Map();
  for (const collection of metadata) {
    validateCollectionMetadata(collection);
    if (byName.has(collection.name)) {
      throw new Error("V2 history collection metadata contains duplicate names.");
    }
    byName.set(collection.name, collection);
  }
  return byName;
}

function exactKey(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length &&
    actualEntries.every(([key, value], index) =>
      key === expectedEntries[index][0] && value === expectedEntries[index][1]);
}

function isTtlIndex(index) {
  return index !== null && typeof index === "object" &&
    Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds");
}

async function readIndexes(collection) {
  if (!collection || typeof collection.listIndexes !== "function") {
    throw new Error("V2 history collection does not provide index inspection.");
  }
  let cursor;
  try {
    cursor = collection.listIndexes();
  } catch {
    throw new Error("Unable to inspect V2 history collection indexes.");
  }
  if (!cursor || typeof cursor.toArray !== "function") {
    throw new Error("Unable to inspect V2 history collection indexes.");
  }
  try {
    return await cursor.toArray();
  } catch {
    throw new Error("Unable to inspect V2 history collection indexes.");
  }
}

async function verifyExistingIndexes(collection, role) {
  const indexes = await readIndexes(collection);
  if (!Array.isArray(indexes)) {
    throw new Error("V2 history collection index metadata is malformed.");
  }
  const idIndex = indexes.find((index) => index && index.name === "_id_");
  if (!idIndex || !exactKey(idIndex.key, { _id: 1 }) || idIndex.unique === false) {
    throw new Error("V2 history collection has an incompatible built-in _id_ index.");
  }

  if (role === "receipts") {
    if (indexes.some(isTtlIndex)) {
      throw new Error("V2 history receipt collection must not have a TTL index.");
    }
    return;
  }

  const ttlIndexes = indexes.filter(isTtlIndex);
  const createdAtIndexes = indexes.filter((index) => index &&
    index.key && Object.prototype.hasOwnProperty.call(index.key, "createdAt"));
  if (ttlIndexes.length > 1 || createdAtIndexes.length > 1) {
    throw new Error("V2 history collection has conflicting TTL indexes.");
  }
  if (ttlIndexes.length === 0 && createdAtIndexes.length === 0) return;

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
}

async function provisionHistoryCollections({
  database,
  mongoClient,
  provisionAcknowledgement,
  verifyMongoIdentity = verifyHistoryMongoIdentity,
  ensureIndexes = ensureHistoryIndexes,
}) {
  validateDependencies({ database, mongoClient, provisionAcknowledgement });
  if (typeof verifyMongoIdentity !== "function" ||
      typeof ensureIndexes !== "function") {
    throw new Error("Invalid V2 history provisioning verifier or index manager.");
  }

  try {
    await verifyMongoIdentity({
      mongoClient,
      config: HISTORY_IDENTITY_CONFIG,
    });
  } catch {
    throw new Error("V2 history MongoDB identity preflight failed.");
  }

  const namesByRole = {
    history: HISTORY_COLLECTION_NAMES.history,
    receipts: HISTORY_COLLECTION_NAMES.receipts,
  };
  const initialMetadata = await readCollectionMetadata(database);
  for (const role of ["history", "receipts"]) {
    const name = namesByRole[role];
    if (initialMetadata.has(name)) {
      await verifyExistingIndexes(database.collection(name), role);
    }
  }

  const collectionResults = {};

  for (const role of ["history", "receipts"]) {
    const name = namesByRole[role];
    if (initialMetadata.has(name)) {
      collectionResults[role] = "reused";
      continue;
    }

    try {
      await database.createCollection(
        name,
        expectedHistoryCollectionOptions(name),
      );
      collectionResults[role] = "created";
    } catch (error) {
      if (!error || error.code !== 48) {
        throw new Error("Unable to create an absent V2 history collection.");
      }
      const racedMetadata = await readCollectionMetadata(database);
      if (!racedMetadata.has(name)) {
        throw new Error("A conflicting V2 history collection appeared during provisioning.");
      }
      await verifyExistingIndexes(database.collection(name), role);
      collectionResults[role] = "reused";
    }
  }

  const finalMetadata = await readCollectionMetadata(database);
  for (const name of Object.values(namesByRole)) {
    if (!finalMetadata.has(name)) {
      throw new Error("A V2 history collection is missing after provisioning.");
    }
  }

  const historyCollection = database.collection(namesByRole.history);
  const receiptCollection = database.collection(namesByRole.receipts);
  let indexResult;
  try {
    indexResult = await ensureIndexes({
      historyCollection,
      receiptCollection,
    });
  } catch {
    throw new Error("Unable to verify or configure V2 history indexes.");
  }
  if (!indexResult ||
      indexResult.historyIdIndex !== "_id_" ||
      indexResult.receiptIdIndex !== "_id_" ||
      typeof indexResult.historyTtlIndex !== "string") {
    throw new Error("V2 history index verification returned an invalid result.");
  }

  return Object.freeze({
    databaseName: HISTORY_DATABASE_NAME,
    collections: Object.freeze({
      history: Object.freeze({
        name: namesByRole.history,
        status: collectionResults.history,
      }),
      receipts: Object.freeze({
        name: namesByRole.receipts,
        status: collectionResults.receipts,
      }),
    }),
    indexes: Object.freeze({
      historyTtlSeconds: HISTORY_TTL_SECONDS,
      receiptsHaveTtl: false,
    }),
  });
}

module.exports = {
  HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
  provisionHistoryCollections,
};
