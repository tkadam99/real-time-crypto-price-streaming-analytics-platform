const { createHash } = require("node:crypto");

const SORT = { timestamp: -1, receivedAt: -1, _id: -1 };
const INDEXES = [
  { key: { symbol: 1, timestamp: -1, receivedAt: 1, _id: 1 }, name: "price_symbol_timestamp_received_id" },
  { key: { symbol: 1, timestamp: 1, receivedAt: 1, _id: 1 }, name: "price_symbol_timestamp_asc_received_id" },
];
const RETENTION_INDEX = INDEXES[1].name;

async function createIndexes(collection) {
  for (const index of INDEXES) await collection.createIndex(index.key, { name: index.name });
}

function referenceQuery(collection, symbol, target, hinted = false) {
  let query = collection.find({ symbol }).sort(SORT).skip(target).project({ _id: 1 });
  if (hinted) query = query.hint(RETENTION_INDEX);
  return query;
}

function boundaryQuery(collection, symbol, target) {
  return collection.find({ symbol }).sort(SORT).skip(target).limit(1)
    .project({ _id: 1, timestamp: 1, receivedAt: 1 });
}

function olderThan(symbol, boundary) {
  return {
    symbol,
    $or: [
      { timestamp: { $lt: boundary.timestamp } },
      { timestamp: boundary.timestamp, receivedAt: { $lt: boundary.receivedAt } },
      { timestamp: boundary.timestamp, receivedAt: boundary.receivedAt, _id: { $lte: boundary._id } },
    ],
  };
}

async function reference(collection, symbol, target, hooks = {}, hinted = false) {
  if (hooks.beforeRead) await hooks.beforeRead();
  const oldDocs = await referenceQuery(collection, symbol, target, hinted).toArray();
  if (oldDocs.length === 0) return { deleted: 0 };
  const filter = { symbol, _id: { $in: oldDocs.map((doc) => doc._id) } };
  if (hooks.beforeDelete) await hooks.beforeDelete(filter);
  const result = await collection.deleteMany(filter);
  return { deleted: result.deletedCount };
}

async function boundary(collection, symbol, target, hooks = {}) {
  if (hooks.beforeRead) await hooks.beforeRead();
  const [cutoff] = await boundaryQuery(collection, symbol, target).toArray();
  if (!cutoff) return { deleted: 0 };
  const filter = olderThan(symbol, cutoff);
  if (hooks.beforeDelete) await hooks.beforeDelete(filter);
  const result = await collection.deleteMany(filter);
  return { deleted: result.deletedCount };
}

const algorithms = {
  reference,
  hinted: (collection, symbol, target, hooks) => reference(collection, symbol, target, hooks, true),
  boundary,
};

function event(symbol, index, options = {}) {
  const timestamp = options.timestamp || new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString();
  return {
    _id: JSON.stringify(["test-topic", symbol === "BTC-USD" ? 0 : 1, String(index)]),
    symbol, price: index + 100, timestamp,
    receivedAt: options.receivedAt || timestamp,
    previousPrice: null, percentChange: 0, alertCandidate: null,
  };
}

async function upsertEvent(collection, document) {
  const { _id, ...fields } = document;
  await collection.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
}

async function ordered(collection) {
  return collection.find({}).sort({ symbol: 1, ...SORT }).toArray();
}

function signature(documents) {
  return createHash("sha256").update(JSON.stringify(documents.map((doc) => doc._id))).digest("hex");
}

async function historyInputs(collection, symbol) {
  const recent = await collection.find({ symbol }).sort({ timestamp: -1, receivedAt: 1, _id: 1 })
    .limit(5).toArray();
  const latest = recent[0];
  if (!latest) return { recent: [], predecessor: null, movingAverage: null };
  const latestTime = Date.parse(latest.timestamp);
  let previous = recent.find((item) => Date.parse(item.timestamp) < latestTime);
  if (!previous) {
    previous = await collection.find({ symbol, timestamp: { $lt: latest.timestamp } })
      .sort(SORT).limit(1).next();
  }
  return {
    recent: recent.map((item) => item._id),
    predecessor: previous?._id ?? null,
    movingAverage: recent.reduce((sum, item) => sum + item.price, 0) / recent.length,
  };
}

module.exports = {
  SORT, INDEXES, algorithms, boundaryQuery, createIndexes, event,
  historyInputs, olderThan, ordered, referenceQuery, signature, upsertEvent,
};
