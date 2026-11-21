const {
  HISTORY_TTL_INDEX_NAME,
  HISTORY_TTL_SECONDS,
  ensureHistoryIndexes,
} = require("../v2/historyIndexes");

function idIndex() {
  return { name: "_id_", key: { _id: 1 } };
}

function createCollection(initialIndexes = [idIndex()]) {
  const indexes = [...initialIndexes];
  const collection = {
    indexes,
    listIndexes: jest.fn(() => ({
      toArray: jest.fn(async () => indexes.map((index) => ({ ...index }))),
    })),
    createIndex: jest.fn(async (key, options) => {
      indexes.push({
        name: options.name,
        key: { ...key },
        expireAfterSeconds: options.expireAfterSeconds,
      });
      return options.name;
    }),
  };
  return collection;
}

test("accepts MongoDB's built-in _id_ listIndexes shape without an explicit unique field", async () => {
  const historyCollection = createCollection();
  const receiptCollection = createCollection();

  await expect(ensureHistoryIndexes({ historyCollection, receiptCollection }))
    .resolves.toEqual({
      historyIdIndex: "_id_",
      historyTtlIndex: HISTORY_TTL_INDEX_NAME,
      receiptIdIndex: "_id_",
    });

  expect(historyCollection.createIndex).toHaveBeenCalledWith(
    { createdAt: 1 },
    { name: HISTORY_TTL_INDEX_NAME, expireAfterSeconds: HISTORY_TTL_SECONDS },
  );
  expect(receiptCollection.createIndex).not.toHaveBeenCalled();
  expect(historyCollection.listIndexes).toHaveBeenCalledTimes(2);
  expect(receiptCollection.listIndexes).toHaveBeenCalledTimes(2);
});

test("is idempotent when the correct history TTL index already exists", async () => {
  const historyCollection = createCollection([
    idIndex(),
    {
      name: HISTORY_TTL_INDEX_NAME,
      key: { createdAt: 1 },
      expireAfterSeconds: HISTORY_TTL_SECONDS,
      v: 2,
      ns: "db.price_history",
    },
  ]);
  const receiptCollection = createCollection();

  await ensureHistoryIndexes({ historyCollection, receiptCollection });
  await ensureHistoryIndexes({ historyCollection, receiptCollection });

  expect(historyCollection.createIndex).not.toHaveBeenCalled();
  expect(historyCollection.indexes.filter((index) =>
    Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
  )).toHaveLength(1);
});

test.each([
  ["missing TTL option", { name: "createdAt_1", key: { createdAt: 1 } }],
  ["wrong TTL duration", {
    name: HISTORY_TTL_INDEX_NAME, key: { createdAt: 1 }, expireAfterSeconds: 3600,
  }],
  ["extra index option", {
    name: HISTORY_TTL_INDEX_NAME,
    key: { createdAt: 1 },
    expireAfterSeconds: HISTORY_TTL_SECONDS,
    sparse: true,
  }],
  ["unrelated TTL index", {
    name: "other_ttl",
    key: { otherDate: 1 },
    expireAfterSeconds: 60,
  }],
])("rejects a conflicting history index: %s", async (_label, conflictingIndex) => {
  const historyCollection = createCollection([idIndex(), conflictingIndex]);
  const receiptCollection = createCollection();

  await expect(ensureHistoryIndexes({ historyCollection, receiptCollection })).rejects.toThrow();
  expect(historyCollection.createIndex).not.toHaveBeenCalled();
});

test("rejects any TTL index on durable receipts without modifying indexes", async () => {
  const historyCollection = createCollection();
  const receiptCollection = createCollection([
    idIndex(),
    { name: "receipt_ttl", key: { createdAt: 1 }, expireAfterSeconds: 86400 },
  ]);

  await expect(ensureHistoryIndexes({ historyCollection, receiptCollection }))
    .rejects.toThrow("receipt collection must not have a TTL index");
  expect(historyCollection.createIndex).not.toHaveBeenCalled();
  expect(receiptCollection.createIndex).not.toHaveBeenCalled();
});

test.each([
  ["missing built-in index", [{ name: "id_custom", key: { _id: 1 } }]],
  ["wrong key", [{ name: "_id_", key: { other: 1 } }]],
  ["explicitly non-unique", [{ name: "_id_", key: { _id: 1 }, unique: false }]],
  ["compound key", [{ name: "_id_", key: { _id: 1, other: 1 } }]],
])("rejects malformed _id_ index definition: %s", async (_label, indexes) => {
  const historyCollection = createCollection(indexes);
  const receiptCollection = createCollection();

  await expect(ensureHistoryIndexes({ historyCollection, receiptCollection }))
    .rejects.toThrow("built-in unique _id_ index");
  expect(historyCollection.createIndex).not.toHaveBeenCalled();
});

test("re-reads and fails if index creation does not produce the requested TTL", async () => {
  const historyCollection = createCollection();
  historyCollection.createIndex.mockResolvedValue(HISTORY_TTL_INDEX_NAME);
  const receiptCollection = createCollection();

  await expect(ensureHistoryIndexes({ historyCollection, receiptCollection }))
    .rejects.toThrow("history TTL index was not created");
});
