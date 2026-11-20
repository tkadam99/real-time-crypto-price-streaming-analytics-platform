const {
  HISTORY_DATABASE_NAME,
  HISTORY_MONGO_MEMBER,
  HISTORY_MONGO_URI,
  HISTORY_REPLICA_SET_NAME,
} = require("../v2/historyConsumerConfig");
const {
  HISTORY_COLLECTION_NAMES,
} = require("../v2/historyCollectionInspection");
const {
  expectedHistoryCollectionOptions,
} = require("../v2/historyCollectionSchema");
const { HISTORY_TTL_INDEX_NAME, HISTORY_TTL_SECONDS } = require("../v2/historyIndexes");
const {
  HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
  provisionHistoryCollections,
} = require("../v2/historyCollectionProvisioning");
const { verifyHistoryMongoIdentity } = require("../v2/historyConsumerPreflight");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createCollection(initialIndexes = [{ name: "_id_", key: { _id: 1 } }]) {
  const indexes = [...initialIndexes];
  return {
    indexes,
    listIndexes: jest.fn(() => ({
      toArray: jest.fn(async () => indexes.map(clone)),
    })),
    createIndex: jest.fn(async (key, options) => {
      indexes.push({
        name: options.name,
        key: clone(key),
        expireAfterSeconds: options.expireAfterSeconds,
      });
      return options.name;
    }),
    insertOne: jest.fn(),
    findOne: jest.fn(),
  };
}

function createHarness({
  databaseName = HISTORY_DATABASE_NAME,
  databaseClientMatches = true,
  initialCollections = [],
  hello = {
    setName: "rs-v2",
    isWritablePrimary: true,
    me: "v2-mongodb:27017",
  },
  status = {
    set: "rs-v2",
    members: [{
      name: "v2-mongodb:27017",
      stateStr: "PRIMARY",
      self: true,
    }],
  },
  provisionAcknowledgement = HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
  ensureIndexes,
  verifyMongoIdentity,
} = {}) {
  const events = [];
  const metadata = initialCollections.map(({
    name,
    options,
    type = "collection",
    namespace,
    ns,
  }) => ({
    name,
    type,
    options: clone(options),
    ...(namespace === undefined ? {} : { namespace }),
    ...(ns === undefined ? {} : { ns }),
  }));
  const collections = new Map(
    initialCollections.map(({ name, indexes }) => [
      name,
      createCollection(indexes),
    ]),
  );
  const database = {
    databaseName,
    listCollections: jest.fn((filter) => {
      events.push("database.listCollections");
      const requestedNames = filter && filter.name && filter.name.$in;
      return {
        toArray: jest.fn(async () => metadata
          .filter((entry) => !requestedNames || requestedNames.includes(entry.name))
          .map(clone)),
      };
    }),
    createCollection: jest.fn(async (name, options) => {
      events.push(`database.createCollection:${name}`);
      if (metadata.some((entry) => entry.name === name)) {
        const error = new Error("namespace exists");
        error.code = 48;
        throw error;
      }
      metadata.push({
        name,
        type: "collection",
        options: clone(options),
      });
      const collection = createCollection();
      collections.set(name, collection);
      return collection;
    }),
    collection: jest.fn((name) => {
      events.push(`database.collection:${name}`);
      return collections.get(name);
    }),
  };
  const adminDatabase = {
    command: jest.fn(async (command) => {
      events.push(command.hello === 1 ? "mongo.hello" : "mongo.replSetGetStatus");
      return command.hello === 1 ? hello : status;
    }),
  };
  const mongoClient = {
    db: jest.fn((name) => {
      events.push(`mongo.db:${name}`);
      if (name !== "admin") throw new Error("unexpected database request");
      return adminDatabase;
    }),
  };
  database.client = databaseClientMatches ? mongoClient : { db: mongoClient.db };

  const resultPromise = (options = {}) => provisionHistoryCollections({
    database,
    mongoClient,
    provisionAcknowledgement,
    ensureIndexes,
    verifyMongoIdentity,
    ...options,
  });

  return {
    adminDatabase,
    collections,
    database,
    events,
    metadata,
    mongoClient,
    resultPromise,
  };
}

function markedCollection(name, options = expectedHistoryCollectionOptions(name)) {
  return {
    name,
    options,
    indexes: [{ name: "_id_", key: { _id: 1 } }],
  };
}

test("requires its exact provisioning acknowledgement before preflight or inspection", async () => {
  const harness = createHarness({
    provisionAcknowledgement: "true",
  });

  await expect(harness.resultPromise())
    .rejects.toThrow("V2 history collection provisioning acknowledgement is required.");
  expect(harness.mongoClient.db).not.toHaveBeenCalled();
  expect(harness.database.listCollections).not.toHaveBeenCalled();
  expect(harness.database.createCollection).not.toHaveBeenCalled();
});

test("rejects a database other than crypto_analytics_v2 before identity checks", async () => {
  const harness = createHarness({ databaseName: "crypto_analytics" });

  await expect(harness.resultPromise())
    .rejects.toThrow("approved MongoDB database");
  expect(harness.mongoClient.db).not.toHaveBeenCalled();
  expect(harness.database.listCollections).not.toHaveBeenCalled();
});

test("rejects a database object owned by a different MongoDB client", async () => {
  const harness = createHarness({ databaseClientMatches: false });

  await expect(harness.resultPromise())
    .rejects.toThrow("approved MongoDB database");
  expect(harness.mongoClient.db).not.toHaveBeenCalled();
  expect(harness.database.listCollections).not.toHaveBeenCalled();
});

test("fails MongoDB identity preflight before inspection or writes", async () => {
  const harness = createHarness({
    hello: {
      setName: "rs-v1",
      isWritablePrimary: true,
      me: "v2-mongodb:27017",
    },
  });

  await expect(harness.resultPromise())
    .rejects.toThrow("V2 history MongoDB identity preflight failed.");
  expect(harness.events).toEqual(["mongo.db:admin", "mongo.hello"]);
  expect(harness.database.listCollections).not.toHaveBeenCalled();
  expect(harness.database.createCollection).not.toHaveBeenCalled();
});

test("creates fresh collections only after identity and metadata checks", async () => {
  const verifyMongoIdentity = jest.fn(verifyHistoryMongoIdentity);
  const harness = createHarness({ verifyMongoIdentity });

  await expect(harness.resultPromise()).resolves.toEqual({
    databaseName: HISTORY_DATABASE_NAME,
    collections: {
      history: { name: "price_history", status: "created" },
      receipts: { name: "replay_receipts", status: "created" },
    },
    indexes: {
      historyTtlSeconds: HISTORY_TTL_SECONDS,
      receiptsHaveTtl: false,
    },
  });

  expect(harness.events.indexOf("mongo.replSetGetStatus"))
    .toBeLessThan(harness.events.indexOf("database.listCollections"));
  expect(harness.events.indexOf("database.listCollections"))
    .toBeLessThan(harness.events.indexOf("database.createCollection:price_history"));
  expect(harness.database.createCollection).toHaveBeenNthCalledWith(
    1,
    HISTORY_COLLECTION_NAMES.history,
    expectedHistoryCollectionOptions(HISTORY_COLLECTION_NAMES.history),
  );
  expect(harness.database.createCollection).toHaveBeenNthCalledWith(
    2,
    HISTORY_COLLECTION_NAMES.receipts,
    expectedHistoryCollectionOptions(HISTORY_COLLECTION_NAMES.receipts),
  );
  expect(verifyMongoIdentity.mock.calls[0][0].config).toEqual({
    mongo: {
      uri: HISTORY_MONGO_URI,
      databaseName: HISTORY_DATABASE_NAME,
      replicaSetName: HISTORY_REPLICA_SET_NAME,
      member: HISTORY_MONGO_MEMBER,
    },
  });
  expect(harness.collections.get("price_history").indexes).toContainEqual({
    name: HISTORY_TTL_INDEX_NAME,
    key: { createdAt: 1 },
    expireAfterSeconds: HISTORY_TTL_SECONDS,
  });
  expect(harness.collections.get("replay_receipts").indexes.some((index) =>
    Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
  )).toBe(false);
});

test("reuses owned collections on an idempotent rerun", async () => {
  const harness = createHarness({
    initialCollections: [
      markedCollection("price_history"),
      markedCollection("replay_receipts"),
    ],
  });

  const first = await harness.resultPromise();
  const second = await harness.resultPromise();

  expect(first.collections.history.status).toBe("reused");
  expect(first.collections.receipts.status).toBe("reused");
  expect(second).toEqual(first);
  expect(harness.database.createCollection).not.toHaveBeenCalled();
  expect(harness.collections.get("price_history").createIndex).toHaveBeenCalledTimes(1);
  expect(harness.collections.get("replay_receipts").createIndex).not.toHaveBeenCalled();
});

test("resumes a partial provisioning only when the existing collection is fully marked", async () => {
  const harness = createHarness({
    initialCollections: [markedCollection("price_history")],
  });

  const result = await harness.resultPromise();

  expect(result.collections).toEqual({
    history: { name: "price_history", status: "reused" },
    receipts: { name: "replay_receipts", status: "created" },
  });
  expect(harness.database.createCollection).toHaveBeenCalledTimes(1);
  expect(harness.database.createCollection).toHaveBeenCalledWith(
    "replay_receipts",
    expectedHistoryCollectionOptions("replay_receipts"),
  );
});

test.each([
  [
    "missing ownership options",
    { name: "price_history", options: {}, indexes: [{ name: "_id_", key: { _id: 1 } }] },
  ],
  [
    "wrong ownership version",
    (() => {
      const options = expectedHistoryCollectionOptions("price_history");
      options.validator.$jsonSchema.title = "crypto_analytics_v2.price_history:crypto-v2-history:v2";
      return { name: "price_history", options, indexes: [{ name: "_id_", key: { _id: 1 } }] };
    })(),
  ],
  [
    "unexpected collection type",
    { ...markedCollection("price_history"), type: "view" },
  ],
  [
    "unexpected namespace",
    {
      ...markedCollection("price_history"),
      namespace: "other_database.price_history",
    },
  ],
])("refuses an existing collection with %s before creating anything", async (_label, existing) => {
  const harness = createHarness({
    initialCollections: [existing],
  });

  await expect(harness.resultPromise()).rejects.toThrow();
  expect(harness.database.createCollection).not.toHaveBeenCalled();
});

test("rejects an incompatible existing index before creating the missing collection", async () => {
  const history = markedCollection("price_history");
  history.indexes.push({
    name: "bad_history_ttl",
    key: { createdAt: 1 },
    expireAfterSeconds: 3600,
  });
  const harness = createHarness({ initialCollections: [history] });

  await expect(harness.resultPromise())
    .rejects.toThrow("incompatible createdAt index");
  expect(harness.database.createCollection).not.toHaveBeenCalled();
});

test("reports index-manager failure without dropping or altering created collections", async () => {
  const ensureIndexes = jest.fn().mockRejectedValue(
    new Error("mongodb://private/credentials"),
  );
  const harness = createHarness({ ensureIndexes });

  await expect(harness.resultPromise())
    .rejects.toThrow("Unable to verify or configure V2 history indexes.");
  expect(harness.metadata.map((item) => item.name).sort()).toEqual([
    "price_history",
    "replay_receipts",
  ]);
  expect(harness.database).not.toHaveProperty("dropDatabase");
  expect(harness.database).not.toHaveProperty("dropCollection");
  expect(harness.database.createCollection).toHaveBeenCalledTimes(2);
  expect(ensureIndexes).toHaveBeenCalledTimes(1);
});

test("rejects a receipt TTL index before creating a missing history collection", async () => {
  const receipt = markedCollection("replay_receipts");
  receipt.indexes.push({
    name: "receipt_ttl",
    key: { createdAt: 1 },
    expireAfterSeconds: 86400,
  });
  const harness = createHarness({ initialCollections: [receipt] });

  await expect(harness.resultPromise())
    .rejects.toThrow("receipt collection must not have a TTL index");
  expect(harness.database.createCollection).not.toHaveBeenCalled();
});
