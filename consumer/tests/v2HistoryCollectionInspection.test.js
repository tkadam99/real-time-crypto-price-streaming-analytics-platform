const { HISTORY_DATABASE_NAME } = require("../v2/historyConsumerConfig");
const { inspectHistoryCollections } = require("../v2/historyCollectionInspection");

function createDatabase({
  databaseName = HISTORY_DATABASE_NAME,
  collections = [],
  listCollectionsImpl,
} = {}) {
  const toArray = jest.fn(async () => collections);
  const database = {
    databaseName,
    listCollections: jest.fn(
      listCollectionsImpl || (() => ({ toArray })),
    ),
    createCollection: jest.fn(),
    collection: jest.fn(),
  };
  return { database, toArray };
}

test("reports both approved collections absent without granting creation permission", async () => {
  const { database, toArray } = createDatabase();

  await expect(inspectHistoryCollections(database)).resolves.toEqual({
    databaseName: HISTORY_DATABASE_NAME,
    firstRun: true,
    creationPermitted: false,
    collections: {
      history: { name: "price_history", exists: false },
      receipts: { name: "replay_receipts", exists: false },
    },
  });
  expect(database.listCollections).toHaveBeenCalledWith(
    { name: { $in: ["price_history", "replay_receipts"] } },
    { nameOnly: false },
  );
  expect(toArray).toHaveBeenCalledTimes(1);
  expect(database.createCollection).not.toHaveBeenCalled();
  expect(database.collection).not.toHaveBeenCalled();
});

test.each([
  [
    "one existing collection",
    [{ name: "price_history", type: "collection" }],
  ],
  [
    "both existing collections",
    [
      { name: "price_history", type: "collection" },
      { name: "replay_receipts", type: "collection" },
    ],
  ],
])("rejects %s without established ownership", async (_label, collections) => {
  const { database } = createDatabase({ collections });

  await expect(inspectHistoryCollections(database))
    .rejects.toThrow(
      "Preexisting V2 history collections require separately approved ownership verification.",
    );
  expect(database.createCollection).not.toHaveBeenCalled();
  expect(database.collection).not.toHaveBeenCalled();
});

test("rejects views and incompatible collection types", async () => {
  const viewDatabase = createDatabase({
    collections: [{ name: "price_history", type: "view" }],
  });
  await expect(inspectHistoryCollections(viewDatabase.database))
    .rejects.toThrow("must not resolve to views");

  const timeSeriesDatabase = createDatabase({
    collections: [{
      name: "price_history",
      type: "timeseries",
      options: { timeseries: { timeField: "createdAt" } },
    }],
  });
  await expect(inspectHistoryCollections(timeSeriesDatabase.database))
    .rejects.toThrow("incompatible collection type");

  const cappedDatabase = createDatabase({
    collections: [{
      name: "price_history",
      type: "collection",
      options: { capped: true },
    }],
  });
  await expect(inspectHistoryCollections(cappedDatabase.database))
    .rejects.toThrow("incompatible collection type");
});

test.each([
  ["missing name", { type: "collection" }],
  ["missing type", { name: "price_history" }],
  ["unexpected name", { name: "other_collection", type: "collection" }],
  [
    "unexpected namespace",
    { name: "price_history", type: "collection", ns: "other_db.price_history" },
  ],
])("rejects malformed or unexpected metadata: %s", async (_label, metadata) => {
  const { database } = createDatabase({ collections: [metadata] });

  await expect(inspectHistoryCollections(database)).rejects.toThrow();
});

test("rejects duplicate collection metadata", async () => {
  const { database } = createDatabase({
    collections: [
      { name: "price_history", type: "collection" },
      { name: "price_history", type: "collection" },
    ],
  });

  await expect(inspectHistoryCollections(database))
    .rejects.toThrow("duplicate names");
});

test("rejects a database other than the approved V2 database before listing", async () => {
  const { database } = createDatabase({ databaseName: "crypto_analytics" });

  await expect(inspectHistoryCollections(database))
    .rejects.toThrow("approved database");
  expect(database.listCollections).not.toHaveBeenCalled();
});

test("sanitizes listCollections failures", async () => {
  const { database } = createDatabase({
    listCollectionsImpl: () => {
      throw new Error("mongodb://user:secret@private-host");
    },
  });

  await expect(inspectHistoryCollections(database))
    .rejects.toThrow("Unable to inspect approved V2 history collections.");
});
