const { HISTORY_DATABASE_NAME } = require("./historyConsumerConfig");

const HISTORY_COLLECTION_NAMES = Object.freeze({
  history: "price_history",
  receipts: "replay_receipts",
});
const EXPECTED_COLLECTION_NAMES = new Set(Object.values(HISTORY_COLLECTION_NAMES));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateNamespace(collection, databaseName) {
  const expectedNamespace = `${databaseName}.${collection.name}`;
  for (const field of ["namespace", "ns"]) {
    if (Object.prototype.hasOwnProperty.call(collection, field) &&
        collection[field] !== expectedNamespace) {
      throw new Error("V2 history collection metadata contains an unexpected namespace.");
    }
  }
}

function validateCollectionMetadata(collection, databaseName) {
  if (!isRecord(collection) || typeof collection.name !== "string" ||
      typeof collection.type !== "string") {
    throw new Error("V2 history collection metadata is malformed.");
  }
  if (collection.options !== undefined && !isRecord(collection.options)) {
    throw new Error("V2 history collection metadata is malformed.");
  }
  if (!EXPECTED_COLLECTION_NAMES.has(collection.name)) {
    throw new Error("V2 history collection metadata contains an unexpected namespace.");
  }

  validateNamespace(collection, databaseName);
  if (collection.type === "view") {
    throw new Error("V2 history collection names must not resolve to views.");
  }
  if (collection.type !== "collection" ||
      (collection.options &&
        (collection.options.viewOn !== undefined ||
          collection.options.timeseries !== undefined ||
          collection.options.capped === true))) {
    throw new Error("V2 history collection has an incompatible collection type.");
  }
}

async function inspectHistoryCollections(database) {
  if (!database || database.databaseName !== HISTORY_DATABASE_NAME ||
      typeof database.listCollections !== "function") {
    throw new Error("V2 history collection inspection requires the approved database.");
  }

  let cursor;
  try {
    cursor = database.listCollections(
      { name: { $in: Object.values(HISTORY_COLLECTION_NAMES) } },
      { nameOnly: false },
    );
  } catch {
    throw new Error("Unable to inspect approved V2 history collections.");
  }
  if (!cursor || typeof cursor.toArray !== "function") {
    throw new Error("Unable to inspect approved V2 history collections.");
  }

  let collections;
  try {
    collections = await cursor.toArray();
  } catch {
    throw new Error("Unable to inspect approved V2 history collections.");
  }
  if (!Array.isArray(collections)) {
    throw new Error("V2 history collection metadata is malformed.");
  }

  const existingNames = new Set();
  for (const collection of collections) {
    validateCollectionMetadata(collection, database.databaseName);
    if (existingNames.has(collection.name)) {
      throw new Error("V2 history collection metadata contains duplicate names.");
    }
    existingNames.add(collection.name);
  }

  if (existingNames.size > 0) {
    throw new Error(
      "Preexisting V2 history collections require separately approved ownership verification.",
    );
  }

  return Object.freeze({
    databaseName: HISTORY_DATABASE_NAME,
    firstRun: true,
    creationPermitted: false,
    collections: Object.freeze({
      history: Object.freeze({
        name: HISTORY_COLLECTION_NAMES.history,
        exists: false,
      }),
      receipts: Object.freeze({
        name: HISTORY_COLLECTION_NAMES.receipts,
        exists: false,
      }),
    }),
  });
}

module.exports = {
  HISTORY_COLLECTION_NAMES,
  inspectHistoryCollections,
};
