const { MongoClient } = require("mongodb");
const {
  HISTORY_DATABASE_NAME,
  HISTORY_MONGO_URI,
} = require("../v2/historyConsumerConfig");
const {
  HISTORY_COLLECTION_NAMES,
} = require("../v2/historyCollectionInspection");
const {
  expectedHistoryCollectionOptions,
} = require("../v2/historyCollectionSchema");
const {
  verifyHistoryCollectionOwnership,
} = require("../v2/historyCollectionOwnershipVerification");
const {
  HISTORY_TTL_INDEX_NAME,
  HISTORY_TTL_SECONDS,
} = require("../v2/historyIndexes");

const openClients = new Set();

function collectionMetadata(name, options = expectedHistoryCollectionOptions(name)) {
  return {
    name,
    type: "collection",
    options,
  };
}

function defaultIndexes() {
  return {
    history: [
      { name: "_id_", key: { _id: 1 }, unique: true },
      {
        name: HISTORY_TTL_INDEX_NAME,
        key: { createdAt: 1 },
        expireAfterSeconds: HISTORY_TTL_SECONDS,
      },
    ],
    receipts: [
      { name: "_id_", key: { _id: 1 }, unique: true },
    ],
  };
}

function createFixture({
  databaseName = HISTORY_DATABASE_NAME,
  metadata,
  indexes = defaultIndexes(),
} = {}) {
  const mongoClient = new MongoClient(HISTORY_MONGO_URI);
  openClients.add(mongoClient);
  const database = mongoClient.db(databaseName);
  const historyCollection = database.collection(HISTORY_COLLECTION_NAMES.history);
  const receiptCollection = database.collection(HISTORY_COLLECTION_NAMES.receipts);
  const returnedMetadata = metadata || [
    collectionMetadata(HISTORY_COLLECTION_NAMES.history),
    collectionMetadata(HISTORY_COLLECTION_NAMES.receipts),
  ];

  jest.spyOn(database, "listCollections").mockReturnValue({
    toArray: jest.fn().mockResolvedValue(returnedMetadata),
  });
  jest.spyOn(database, "createCollection");
  jest.spyOn(database, "dropCollection");
  jest.spyOn(database, "dropDatabase");
  jest.spyOn(historyCollection, "listIndexes").mockReturnValue({
    toArray: jest.fn().mockResolvedValue(indexes.history),
  });
  jest.spyOn(receiptCollection, "listIndexes").mockReturnValue({
    toArray: jest.fn().mockResolvedValue(indexes.receipts),
  });
  jest.spyOn(historyCollection, "createIndex");
  jest.spyOn(receiptCollection, "createIndex");

  return {
    database,
    historyCollection,
    mongoClient,
    receiptCollection,
    returnedMetadata,
  };
}

function verify(fixture, overrides = {}) {
  return verifyHistoryCollectionOwnership({
    database: fixture.database,
    mongoClient: fixture.mongoClient,
    historyCollection: fixture.historyCollection,
    receiptCollection: fixture.receiptCollection,
    ...overrides,
  });
}

afterAll(async () => {
  await Promise.all([...openClients].map((client) => client.close()));
});

test("verifies exact owned schemas and compatible indexes without writes", async () => {
  const fixture = createFixture();

  const result = await verify(fixture);

  expect(result).toEqual({
    databaseName: HISTORY_DATABASE_NAME,
    status: "verified",
    collections: {
      history: HISTORY_COLLECTION_NAMES.history,
      receipts: HISTORY_COLLECTION_NAMES.receipts,
    },
    indexes: {
      historyTtl: "verified",
      receiptsTtl: "absent",
    },
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.collections)).toBe(true);
  expect(Object.isFrozen(result.indexes)).toBe(true);
  expect(fixture.database.listCollections).toHaveBeenCalledWith(
    { name: { $in: ["price_history", "replay_receipts"] } },
    { nameOnly: false },
  );
  expect(fixture.database.createCollection).not.toHaveBeenCalled();
  expect(fixture.database.dropCollection).not.toHaveBeenCalled();
  expect(fixture.database.dropDatabase).not.toHaveBeenCalled();
  expect(fixture.historyCollection.createIndex).not.toHaveBeenCalled();
  expect(fixture.receiptCollection.createIndex).not.toHaveBeenCalled();
});

test("allows a compatible history collection without TTL for later index setup", async () => {
  const indexes = defaultIndexes();
  indexes.history = indexes.history.slice(0, 1);
  const fixture = createFixture({ indexes });

  const result = await verify(fixture);

  expect(result.indexes.historyTtl).toBe("pending-setup");
  expect(fixture.historyCollection.createIndex).not.toHaveBeenCalled();
});

test("rejects missing approved collections", async () => {
  const fixture = createFixture({
    metadata: [collectionMetadata(HISTORY_COLLECTION_NAMES.history)],
  });

  await expect(verify(fixture))
    .rejects.toThrow("An approved V2 history collection is missing.");
  expect(fixture.historyCollection.listIndexes).not.toHaveBeenCalled();
});

test.each([
  ["null metadata", [null]],
  [
    "malformed options",
    [{
      name: HISTORY_COLLECTION_NAMES.history,
      type: "collection",
      options: null,
    }],
  ],
  [
    "unexpected namespace",
    [
      {
        ...collectionMetadata(HISTORY_COLLECTION_NAMES.history),
        namespace: "another_database.price_history",
      },
      collectionMetadata(HISTORY_COLLECTION_NAMES.receipts),
    ],
  ],
  [
    "unexpected collection name",
    [
      collectionMetadata(HISTORY_COLLECTION_NAMES.history),
      collectionMetadata(HISTORY_COLLECTION_NAMES.receipts),
      { name: "unapproved", type: "collection", options: {} },
    ],
  ],
])("rejects %s collection metadata", async (_label, metadata) => {
  const fixture = createFixture({ metadata });

  await expect(verify(fixture)).rejects.toThrow();
  expect(fixture.historyCollection.listIndexes).not.toHaveBeenCalled();
});

test("rejects duplicate collection metadata", async () => {
  const history = collectionMetadata(HISTORY_COLLECTION_NAMES.history);
  const fixture = createFixture({
    metadata: [
      history,
      { ...history },
      collectionMetadata(HISTORY_COLLECTION_NAMES.receipts),
    ],
  });

  await expect(verify(fixture))
    .rejects.toThrow("V2 history collection metadata contains duplicate names.");
});

test("rejects views and other incompatible collection types", async () => {
  const fixture = createFixture({
    metadata: [
      {
        name: HISTORY_COLLECTION_NAMES.history,
        type: "view",
        options: { viewOn: "source" },
      },
      collectionMetadata(HISTORY_COLLECTION_NAMES.receipts),
    ],
  });

  await expect(verify(fixture))
    .rejects.toThrow("incompatible collection type");
});

test.each([
  ["wrong ownership marker", (options) => {
    options.validator.$jsonSchema.title = "unexpected-owner";
    return options;
  }],
  ["non-strict validation", (options) => {
    options.validationLevel = "moderate";
    return options;
  }],
  ["non-error validation action", (options) => {
    options.validationAction = "warn";
    return options;
  }],
  ["missing validator", (options) => {
    delete options.validator;
    return options;
  }],
])("rejects collection with %s", async (_label, mutate) => {
  const options = mutate(expectedHistoryCollectionOptions(HISTORY_COLLECTION_NAMES.history));
  const fixture = createFixture({
    metadata: [
      collectionMetadata(HISTORY_COLLECTION_NAMES.history, options),
      collectionMetadata(HISTORY_COLLECTION_NAMES.receipts),
    ],
  });

  await expect(verify(fixture))
    .rejects.toThrow("ownership or schema does not match");
});

test("rejects a database other than crypto_analytics_v2 before inspection", async () => {
  const fixture = createFixture({ databaseName: "another_database" });

  await expect(verify(fixture))
    .rejects.toThrow("approved MongoDB database and client");
  expect(fixture.database.listCollections).not.toHaveBeenCalled();
});

test("rejects a database associated with another injected MongoClient", async () => {
  const fixture = createFixture();
  const otherClient = new MongoClient(HISTORY_MONGO_URI);
  openClients.add(otherClient);

  await expect(verify(fixture, { mongoClient: otherClient }))
    .rejects.toThrow("approved MongoDB database and client");
  expect(fixture.database.listCollections).not.toHaveBeenCalled();
});

test("rejects collection handles from another database", async () => {
  const fixture = createFixture();
  const otherDatabase = fixture.mongoClient.db("another_database");
  const otherHistoryCollection =
    otherDatabase.collection(HISTORY_COLLECTION_NAMES.history);

  await expect(verify(fixture, { historyCollection: otherHistoryCollection }))
    .rejects.toThrow("collections from the approved MongoDB client and database");
  expect(fixture.database.listCollections).not.toHaveBeenCalled();
});

test.each([
  [
    "conflicting history TTL indexes",
    {
      history: [
        { name: "_id_", key: { _id: 1 }, unique: true },
        {
          name: "history_ttl_one",
          key: { createdAt: 1 },
          expireAfterSeconds: HISTORY_TTL_SECONDS,
        },
        {
          name: "history_ttl_two",
          key: { createdAt: -1 },
          expireAfterSeconds: HISTORY_TTL_SECONDS,
        },
      ],
      receipts: defaultIndexes().receipts,
    },
    "V2 history collection has conflicting TTL indexes.",
  ],
  [
    "receipt TTL index",
    {
      history: defaultIndexes().history,
      receipts: [
        ...defaultIndexes().receipts,
        {
          name: "receipt_ttl",
          key: { createdAt: 1 },
          expireAfterSeconds: HISTORY_TTL_SECONDS,
        },
      ],
    },
    "V2 history receipt collection must not have a TTL index.",
  ],
  [
    "incorrect history TTL specification",
    {
      history: [
        { name: "_id_", key: { _id: 1 }, unique: true },
        {
          name: HISTORY_TTL_INDEX_NAME,
          key: { createdAt: 1 },
          expireAfterSeconds: 3600,
        },
      ],
      receipts: defaultIndexes().receipts,
    },
    "V2 history collection has an incompatible createdAt index.",
  ],
])("rejects %s without attempting writes", async (_label, indexes, message) => {
  const fixture = createFixture({ indexes });

  await expect(verify(fixture)).rejects.toThrow(message);
  expect(fixture.database.createCollection).not.toHaveBeenCalled();
  expect(fixture.database.dropCollection).not.toHaveBeenCalled();
  expect(fixture.database.dropDatabase).not.toHaveBeenCalled();
  expect(fixture.historyCollection.createIndex).not.toHaveBeenCalled();
  expect(fixture.receiptCollection.createIndex).not.toHaveBeenCalled();
});

test("sanitizes metadata and index inspection failures", async () => {
  const metadataFixture = createFixture();
  metadataFixture.database.listCollections.mockImplementation(() => {
    throw new Error("mongodb://user:password@host/secret");
  });
  await expect(verify(metadataFixture))
    .rejects.toThrow("Unable to inspect approved V2 history collection metadata.");

  const indexFixture = createFixture();
  indexFixture.historyCollection.listIndexes.mockImplementation(() => {
    throw new Error("private document or connection string");
  });
  await expect(verify(indexFixture))
    .rejects.toThrow("Unable to inspect V2 history collection indexes.");
});
