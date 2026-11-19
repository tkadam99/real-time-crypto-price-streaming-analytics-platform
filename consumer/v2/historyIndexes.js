const HISTORY_TTL_INDEX_NAME = "history_createdAt_ttl_24h";
const HISTORY_TTL_SECONDS = 86400;

function isExactKey(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length &&
    actualEntries.every(([key, value], index) =>
      key === expectedEntries[index][0] && value === expectedEntries[index][1]);
}

function hasTtl(index) {
  return Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds");
}

async function readIndexes(collection, label) {
  if (!collection || typeof collection.listIndexes !== "function") {
    throw new Error(`The ${label} collection must provide listIndexes().`);
  }
  const cursor = collection.listIndexes();
  if (!cursor || typeof cursor.toArray !== "function") {
    throw new Error(`Unable to inspect ${label} collection indexes.`);
  }
  return cursor.toArray();
}

function verifyIdIndex(indexes, label) {
  const idIndex = indexes.find((index) => index && index.name === "_id_");
  if (!idIndex || !isExactKey(idIndex.key, { _id: 1 }) || idIndex.unique === false) {
    throw new Error(`The ${label} collection is missing its built-in unique _id_ index.`);
  }
}

function verifyHistoryTtl(indexes) {
  const ttlIndexes = indexes.filter(hasTtl);
  const createdAtIndexes = indexes.filter((index) => index &&
    index.key && Object.prototype.hasOwnProperty.call(index.key, "createdAt"));

  if (ttlIndexes.length > 1 || createdAtIndexes.length > 1) {
    throw new Error("The history collection has conflicting TTL indexes.");
  }
  if (ttlIndexes.length === 0 && createdAtIndexes.length === 0) return false;

  const index = ttlIndexes[0] || createdAtIndexes[0];
  const supportedFields = new Set([
    "v",
    "key",
    "name",
    "ns",
    "expireAfterSeconds",
  ]);
  if (!isExactKey(index.key, { createdAt: 1 }) ||
      index.expireAfterSeconds !== HISTORY_TTL_SECONDS ||
      Object.keys(index).some((field) => !supportedFields.has(field))) {
    throw new Error("The history collection has an incompatible createdAt index.");
  }
  return true;
}

async function ensureHistoryIndexes({ historyCollection, receiptCollection }) {
  if (!historyCollection || typeof historyCollection.createIndex !== "function") {
    throw new Error("The history collection must provide createIndex().");
  }

  const historyIndexes = await readIndexes(historyCollection, "history");
  const receiptIndexes = await readIndexes(receiptCollection, "receipt");
  verifyIdIndex(historyIndexes, "history");
  verifyIdIndex(receiptIndexes, "receipt");

  if (receiptIndexes.some(hasTtl)) {
    throw new Error("The receipt collection must not have a TTL index.");
  }

  const ttlPresent = verifyHistoryTtl(historyIndexes);
  if (!ttlPresent) {
    await historyCollection.createIndex(
      { createdAt: 1 },
      {
        name: HISTORY_TTL_INDEX_NAME,
        expireAfterSeconds: HISTORY_TTL_SECONDS,
      },
    );
  }

  const finalHistoryIndexes = await readIndexes(historyCollection, "history");
  const finalReceiptIndexes = await readIndexes(receiptCollection, "receipt");
  verifyIdIndex(finalHistoryIndexes, "history");
  verifyIdIndex(finalReceiptIndexes, "receipt");
  if (finalReceiptIndexes.some(hasTtl)) {
    throw new Error("The receipt collection must not have a TTL index.");
  }
  if (!verifyHistoryTtl(finalHistoryIndexes)) {
    throw new Error("The history TTL index was not created.");
  }

  return {
    historyIdIndex: "_id_",
    historyTtlIndex: finalHistoryIndexes.find(hasTtl).name,
    receiptIdIndex: "_id_",
  };
}

module.exports = {
  HISTORY_TTL_INDEX_NAME,
  HISTORY_TTL_SECONDS,
  ensureHistoryIndexes,
};
