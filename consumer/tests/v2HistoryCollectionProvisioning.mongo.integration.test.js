require("dotenv").config();

const { MongoClient } = require("mongodb");
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");
const {
  HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
  provisionHistoryCollectionsForNamespace,
} = require("../v2/historyCollectionProvisioningInternal");
const {
  createHistoryProvisioningTestNamespacePolicy,
} = require("../test-utils/historyProvisioningNamespacePolicy");
const {
  HISTORY_DATABASE_NAME,
  HISTORY_MONGO_MEMBER,
  HISTORY_MONGO_URI,
  HISTORY_REPLICA_SET_NAME,
} = require("../v2/historyConsumerConfig");
const {
  expectedHistoryCollectionOptions,
  matchesExpectedHistoryCollectionOptions,
} = require("../v2/historyCollectionSchema");
const {
  verifyHistoryMongoIdentity,
} = require("../v2/historyConsumerPreflight");
const {
  ensureHistoryIndexes,
  HISTORY_TTL_INDEX_NAME,
  HISTORY_TTL_SECONDS,
} = require("../v2/historyIndexes");

const REQUIRED_INTEGRATION_URI =
  "mongodb://127.0.0.1:27019/admin?directConnection=true";
const integrationUri = getMongoIntegrationUri(process.env);

if (integrationUri !== null && integrationUri !== REQUIRED_INTEGRATION_URI) {
  throw new Error(
    "V2 history provisioning integration tests require mongodb://127.0.0.1:27019/admin?directConnection=true.",
  );
}

const describeMongo = integrationUri ? describe : describe.skip;
const HISTORY_COLLECTION = "price_history";
const RECEIPT_COLLECTION = "replay_receipts";
const IDENTITY_CONFIG = Object.freeze({
  mongo: Object.freeze({
    uri: HISTORY_MONGO_URI,
    databaseName: HISTORY_DATABASE_NAME,
    replicaSetName: HISTORY_REPLICA_SET_NAME,
    member: HISTORY_MONGO_MEMBER,
  }),
});

async function withDisposableDatabase(run) {
  let client;
  let database;
  try {
    client = new MongoClient(integrationUri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      timeoutMS: 15000,
    });
    await client.connect();
    await verifyHistoryMongoIdentity({
      mongoClient: client,
      config: IDENTITY_CONFIG,
    });

    database = createMongoTestDatabase(client, "v2_history_provision_test");
    const namespacePolicy =
      createHistoryProvisioningTestNamespacePolicy(database);
    return await run({ client, database, namespacePolicy });
  } finally {
    try {
      if (database) await dropMongoTestDatabase(database);
    } finally {
      if (client) await client.close();
    }
  }
}

function provision({ client, database, namespacePolicy }) {
  return provisionHistoryCollectionsForNamespace({
    namespacePolicy,
    database,
    mongoClient: client,
    provisionAcknowledgement: HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
    identityConfig: IDENTITY_CONFIG,
    verifyMongoIdentity: verifyHistoryMongoIdentity,
    ensureIndexes: ensureHistoryIndexes,
  });
}

async function readCollectionMetadata(database) {
  return database.listCollections(
    { name: { $in: [HISTORY_COLLECTION, RECEIPT_COLLECTION] } },
    { nameOnly: false },
  ).toArray();
}

async function expectExactCollectionOptions(database) {
  const metadata = await readCollectionMetadata(database);
  expect(metadata).toHaveLength(2);
  const byName = new Map(metadata.map((collection) => [collection.name, collection]));
  for (const name of [HISTORY_COLLECTION, RECEIPT_COLLECTION]) {
    const collection = byName.get(name);
    expect(collection).toBeDefined();
    expect(collection.type).toBe("collection");
    expect(collection.options).toEqual(expectedHistoryCollectionOptions(name));
    expect(matchesExpectedHistoryCollectionOptions(name, collection.options)).toBe(true);
    expect(collection.options.validationLevel).toBe("strict");
    expect(collection.options.validationAction).toBe("error");
  }
}

async function expectIndexPolicy(database) {
  const historyIndexes = await database.collection(HISTORY_COLLECTION)
    .listIndexes().toArray();
  const receiptIndexes = await database.collection(RECEIPT_COLLECTION)
    .listIndexes().toArray();
  const historyTtlIndexes = historyIndexes.filter((index) =>
    Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
  );

  expect(historyTtlIndexes).toHaveLength(1);
  expect(historyTtlIndexes[0]).toMatchObject({
    name: HISTORY_TTL_INDEX_NAME,
    key: { createdAt: 1 },
    expireAfterSeconds: HISTORY_TTL_SECONDS,
  });
  expect(HISTORY_TTL_SECONDS).toBe(86400);
  expect(receiptIndexes.some((index) =>
    Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
  )).toBe(false);
}

describeMongo("V2 history collection provisioning MongoDB integration", () => {
  jest.setTimeout(60000);

  test("provisions fresh collections with exact schemas and history-only TTL", async () => {
    await withDisposableDatabase(async (context) => {
      const result = await provision(context);

      expect(result).toMatchObject({
        databaseName: context.database.databaseName,
        collections: {
          history: { name: HISTORY_COLLECTION, status: "created" },
          receipts: { name: RECEIPT_COLLECTION, status: "created" },
        },
        indexes: {
          historyTtlSeconds: HISTORY_TTL_SECONDS,
          receiptsHaveTtl: false,
        },
      });
      await expectExactCollectionOptions(context.database);
      await expectIndexPolicy(context.database);
    });
  });

  test("reuses owned collections on an idempotent rerun", async () => {
    await withDisposableDatabase(async (context) => {
      const first = await provision(context);
      const second = await provision(context);

      expect(first.collections.history.status).toBe("created");
      expect(first.collections.receipts.status).toBe("created");
      expect(second.collections.history.status).toBe("reused");
      expect(second.collections.receipts.status).toBe("reused");
      await expectExactCollectionOptions(context.database);
      await expectIndexPolicy(context.database);
    });
  });

  test("recovers after history collection creation was interrupted", async () => {
    await withDisposableDatabase(async (context) => {
      const originalCreateCollection = context.database.createCollection;
      context.database.createCollection = async function (name, options) {
        if (name === RECEIPT_COLLECTION) {
          throw new Error("simulated interruption after history creation");
        }
        return originalCreateCollection.call(this, name, options);
      };

      try {
        await expect(provision(context))
          .rejects.toThrow("Unable to create an absent V2 history collection.");
      } finally {
        context.database.createCollection = originalCreateCollection;
      }

      const interruptedMetadata = await readCollectionMetadata(context.database);
      expect(interruptedMetadata.map((collection) => collection.name))
        .toEqual([HISTORY_COLLECTION]);
      expect(matchesExpectedHistoryCollectionOptions(
        HISTORY_COLLECTION,
        interruptedMetadata[0].options,
      )).toBe(true);

      const recovered = await provision(context);
      expect(recovered.collections).toEqual({
        history: { name: HISTORY_COLLECTION, status: "reused" },
        receipts: { name: RECEIPT_COLLECTION, status: "created" },
      });
      await expectExactCollectionOptions(context.database);
      await expectIndexPolicy(context.database);
    });
  });

  test("rejects an unowned collection without creating or changing its counterpart", async () => {
    await withDisposableDatabase(async (context) => {
      await context.database.createCollection(HISTORY_COLLECTION);
      const before = await readCollectionMetadata(context.database);

      await expect(provision(context))
        .rejects.toThrow("ownership or schema does not match");

      const after = await readCollectionMetadata(context.database);
      expect(after).toEqual(before);
      expect(after.map((collection) => collection.name)).toEqual([HISTORY_COLLECTION]);
    });
  });

  test("rejects incompatible collection options without repairing them", async () => {
    await withDisposableDatabase(async (context) => {
      const incompatibleOptions =
        expectedHistoryCollectionOptions(HISTORY_COLLECTION);
      incompatibleOptions.validationLevel = "moderate";
      await context.database.createCollection(
        HISTORY_COLLECTION,
        incompatibleOptions,
      );
      const before = await readCollectionMetadata(context.database);

      await expect(provision(context))
        .rejects.toThrow("ownership or schema does not match");

      const after = await readCollectionMetadata(context.database);
      expect(after).toEqual(before);
      expect(after).toHaveLength(1);
      expect(after[0].options.validationLevel).toBe("moderate");
    });
  });

  test("rejects conflicting history TTL indexes without modifying existing indexes", async () => {
    await withDisposableDatabase(async (context) => {
      await provision(context);
      const history = context.database.collection(HISTORY_COLLECTION);
      await history.createIndex(
        { createdAt: -1 },
        {
          name: "history_createdAt_conflicting_ttl",
          expireAfterSeconds: HISTORY_TTL_SECONDS,
        },
      );
      const indexesBefore = await history.listIndexes().toArray();

      await expect(provision(context))
        .rejects.toThrow("V2 history collection has conflicting TTL indexes.");

      expect(await history.listIndexes().toArray()).toEqual(indexesBefore);
      await expectExactCollectionOptions(context.database);
      const receiptIndexes = await context.database.collection(RECEIPT_COLLECTION)
        .listIndexes().toArray();
      expect(receiptIndexes.some((index) =>
        Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
      )).toBe(false);
    });
  });
});
