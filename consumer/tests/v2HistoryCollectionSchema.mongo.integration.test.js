require("dotenv").config();
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");
const { MongoClient } = require("mongodb");
const { createEnvelope } = require("../v2/eventContract");
const { createHistoryDocuments } = require("../v2/historyContract");
const {
  expectedHistoryCollectionOptions,
  matchesExpectedHistoryCollectionOptions,
} = require("../v2/historyCollectionSchema");
const {
  ensureHistoryIndexes,
  HISTORY_TTL_SECONDS,
} = require("../v2/historyIndexes");

const integrationUri = getMongoIntegrationUri(process.env);

function assertV2MongoEndpoint(uri) {
  if (!uri) return;
  const parsed = new URL(uri);
  const options = [...parsed.searchParams.entries()];
  if (parsed.protocol !== "mongodb:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== "27019" ||
      parsed.pathname !== "/admin" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      options.length !== 1 ||
      options[0][0] !== "directConnection" ||
      options[0][1] !== "true") {
    throw new Error(
      "V2 collection schema integration tests require mongodb://127.0.0.1:27019/admin?directConnection=true.",
    );
  }
}

assertV2MongoEndpoint(integrationUri);
const describeMongo = integrationUri ? describe : describe.skip;

const historyCollectionName = "price_history";
const receiptCollectionName = "replay_receipts";
const envelope = createEnvelope({
  symbol: "BTC-USD",
  price: 105.5,
  timestamp: "2026-01-01T00:01:00+00:00",
}, {
  clusterId: "cluster-a",
  topicGenerationId: "generation-1",
  topic: "crypto-prices",
  partition: 0,
  offset: "9007199254740993",
});

describeMongo("V2 history collection schema MongoDB integration", () => {
  jest.setTimeout(30000);

  let client;
  let db;
  let historyCollection;
  let receiptCollection;

  beforeAll(async () => {
    client = new MongoClient(integrationUri, {
      connectTimeoutMS: 5000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      timeoutMS: 15000,
    });
    await client.connect();

    const admin = client.db("admin");
    const hello = await admin.command({ hello: 1 });
    expect(hello.setName).toBe("rs-v2");
    expect(hello.isWritablePrimary).toBe(true);
    expect(hello.me).toBe("v2-mongodb:27017");

    const status = await admin.command({ replSetGetStatus: 1 });
    expect(status.set).toBe("rs-v2");
    expect(status.members.filter((member) =>
      member.name === "v2-mongodb:27017" &&
      member.stateStr === "PRIMARY" &&
      member.self === true,
    )).toHaveLength(1);

    db = createMongoTestDatabase(client, "v2_history_schema_test");
    await db.createCollection(
      historyCollectionName,
      expectedHistoryCollectionOptions(historyCollectionName),
    );
    await db.createCollection(
      receiptCollectionName,
      expectedHistoryCollectionOptions(receiptCollectionName),
    );
    historyCollection = db.collection(historyCollectionName);
    receiptCollection = db.collection(receiptCollectionName);
  });

  afterAll(async () => {
    try {
      if (db) await dropMongoTestDatabase(db);
    } finally {
      if (client) await client.close();
    }
  });

  test("stores generated validators with exact ownership and strict validation options", async () => {
    const metadata = await db.listCollections(
      { name: { $in: [historyCollectionName, receiptCollectionName] } },
      { nameOnly: false },
    ).toArray();
    const byName = new Map(metadata.map((collection) => [collection.name, collection]));

    expect(metadata).toHaveLength(2);
    for (const name of [historyCollectionName, receiptCollectionName]) {
      const collection = byName.get(name);
      expect(collection.type).toBe("collection");
      expect(matchesExpectedHistoryCollectionOptions(name, collection.options)).toBe(true);
      expect(collection.options.validationLevel).toBe("strict");
      expect(collection.options.validationAction).toBe("error");
    }
  });

  test("accepts historyContract documents with a large exact-string offset and fresh insertion time", async () => {
    const insertedAt = new Date();
    const documents = createHistoryDocuments(envelope, insertedAt);

    await historyCollection.insertOne(documents.history);
    await receiptCollection.insertOne(documents.receipt);

    const storedHistory = await historyCollection.findOne({ _id: documents.history._id });
    const storedReceipt = await receiptCollection.findOne({ _id: documents.receipt._id });
    expect(storedHistory.source.offset).toBe("9007199254740993");
    expect(typeof storedHistory.source.offset).toBe("string");
    expect(storedHistory.createdAt).toEqual(insertedAt);
    expect(storedHistory.timestamp).toBe(envelope.timestamp);
    expect(storedReceipt.source.offset).toBe("9007199254740993");
    expect(storedReceipt).not.toHaveProperty("createdAt");
  });

  test("rejects invalid BSON shapes and unexpected fields in both collections", async () => {
    const insertedAt = new Date();
    const documents = createHistoryDocuments(envelope, insertedAt);

    await expect(historyCollection.insertOne({
      ...documents.history,
      price: "105.5",
    })).rejects.toMatchObject({ code: 121 });
    await expect(historyCollection.insertOne({
      ...documents.history,
      unexpectedField: true,
    })).rejects.toMatchObject({ code: 121 });
    await expect(receiptCollection.insertOne({
      ...documents.receipt,
      source: { ...documents.receipt.source, offset: 9007199254740993 },
    })).rejects.toMatchObject({ code: 121 });
    await expect(receiptCollection.insertOne({
      ...documents.receipt,
      createdAt: insertedAt,
    })).rejects.toMatchObject({ code: 121 });

    expect(await historyCollection.countDocuments({})).toBe(1);
    expect(await receiptCollection.countDocuments({})).toBe(1);
  });

  test("creates only the required history TTL index and remains compatible on repeat", async () => {
    const first = await ensureHistoryIndexes({
      historyCollection,
      receiptCollection,
    });
    const second = await ensureHistoryIndexes({
      historyCollection,
      receiptCollection,
    });
    const historyIndexes = await historyCollection.listIndexes().toArray();
    const receiptIndexes = await receiptCollection.listIndexes().toArray();
    const historyTtlIndexes = historyIndexes.filter((index) =>
      Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
    );

    expect(second).toEqual(first);
    expect(historyTtlIndexes).toHaveLength(1);
    expect(historyTtlIndexes[0].key).toEqual({ createdAt: 1 });
    expect(historyTtlIndexes[0].expireAfterSeconds).toBe(HISTORY_TTL_SECONDS);
    expect(HISTORY_TTL_SECONDS).toBe(86400);
    expect(receiptIndexes.some((index) =>
      Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
    )).toBe(false);
  });
});
