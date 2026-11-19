require("dotenv").config();
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");
const { MongoClient } = require("mongodb");
const { createEnvelope, serializeSourceIdentity } = require("../v2/eventContract");
const { deriveEventIdentity } = require("../v2/historyContract");
const { ensureHistoryIndexes, HISTORY_TTL_SECONDS } = require("../v2/historyIndexes");
const { persistHistoryBatch } = require("../v2/historyBatch");

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
      "V2 history batch integration tests require mongodb://127.0.0.1:27019/admin?directConnection=true.",
    );
  }
}

assertV2MongoEndpoint(integrationUri);
const describeMongo = integrationUri ? describe : describe.skip;

const baseEvent = {
  symbol: "BTC-USD",
  price: 105.5,
  timestamp: "2026-01-01T00:01:00+00:00",
};
const baseSource = {
  clusterId: "cluster-a",
  topicGenerationId: "generation-1",
  topic: "crypto-prices",
  partition: 0,
};

function makeEnvelope(offset, eventOverrides = {}) {
  return createEnvelope(
    { ...baseEvent, ...eventOverrides },
    { ...baseSource, offset: String(offset) },
  );
}

describeMongo("V2 history indexes and batch persistence MongoDB integration", () => {
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

    db = createMongoTestDatabase(client, "v2_history_batch_test");
    await db.createCollection("price_history");
    await db.createCollection("replay_receipts");
    historyCollection = db.collection("price_history");
    receiptCollection = db.collection("replay_receipts");
  });

  afterEach(async () => {
    if (historyCollection) await historyCollection.deleteMany({});
    if (receiptCollection) await receiptCollection.deleteMany({});
  });

  afterAll(async () => {
    try {
      if (db) await dropMongoTestDatabase(db);
    } finally {
      if (client) await client.close();
    }
  });

  test("sets up and verifies history TTL indexes idempotently", async () => {
    const first = await ensureHistoryIndexes({ historyCollection, receiptCollection });
    const second = await ensureHistoryIndexes({ historyCollection, receiptCollection });
    const historyIndexes = await historyCollection.listIndexes().toArray();
    const receiptIndexes = await receiptCollection.listIndexes().toArray();
    const historyTtlIndexes = historyIndexes.filter((index) =>
      Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
    );

    expect(second).toEqual(first);
    expect(historyTtlIndexes).toHaveLength(1);
    expect(historyTtlIndexes[0].key).toEqual({ createdAt: 1 });
    expect(historyTtlIndexes[0].expireAfterSeconds).toBe(HISTORY_TTL_SECONDS);
    expect(receiptIndexes.some((index) =>
      Object.prototype.hasOwnProperty.call(index, "expireAfterSeconds"),
    )).toBe(false);
  });

  test("persists a bounded batch with a duplicate delivery as a confirmed replay", async () => {
    const first = makeEnvelope("9007199254740993");
    const second = makeEnvelope("9007199254740994", { price: 106 });
    const insertedAt = new Date();
    const result = await persistHistoryBatch({
      client,
      historyCollection,
      receiptCollection,
      envelopes: [first, first, second],
      batchSize: 3,
      concurrency: 1,
      insertedAt,
    });

    expect(result).toMatchObject({
      inserted: 2,
      replay: 1,
      failed: 0,
      total: 3,
    });
    expect(result.results.map((item) => item.status)).toEqual([
      "inserted",
      "replay",
      "inserted",
    ]);

    const firstIdentity = deriveEventIdentity(first);
    const secondIdentity = deriveEventIdentity(second);
    expect(result.results.map((item) => item.eventIdentity)).toEqual([
      firstIdentity,
      firstIdentity,
      secondIdentity,
    ]);
    expect(await receiptCollection.countDocuments({})).toBe(2);
    expect(await historyCollection.countDocuments({})).toBe(2);

    const firstReceipt = await receiptCollection.findOne({ _id: firstIdentity });
    const firstHistory = await historyCollection.findOne({ _id: firstIdentity });
    expect(firstReceipt.source.offset).toBe("9007199254740993");
    expect(firstReceipt._id).toBe(serializeSourceIdentity(first.source));
    expect(firstHistory).toMatchObject({
      _id: firstIdentity,
      source: first.source,
      timestamp: first.timestamp,
      createdAt: insertedAt,
    });
    expect(firstHistory.createdAt).not.toEqual(new Date(first.timestamp));
  });

  test("rolls back only the failed input while independent batch items succeed", async () => {
    const first = makeEnvelope("100");
    const failing = makeEnvelope("101");
    const last = makeEnvelope("102");
    const insertedAt = new Date();
    const failingIdentity = deriveEventIdentity(failing);
    const injectedFailure = new Error("Induced history batch write failure.");
    const failingHistoryCollection = new Proxy(historyCollection, {
      get(target, property) {
        if (property === "insertOne") {
          return async (document, options) => {
            if (document._id === failingIdentity) throw injectedFailure;
            return target.insertOne(document, options);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await persistHistoryBatch({
      client,
      historyCollection: failingHistoryCollection,
      receiptCollection,
      envelopes: [first, failing, last],
      batchSize: 3,
      concurrency: 2,
      insertedAt,
    });

    expect(result).toMatchObject({
      inserted: 2,
      replay: 0,
      failed: 1,
      total: 3,
    });
    expect(result.results.map((item) => item.status)).toEqual([
      "inserted",
      "failed",
      "inserted",
    ]);
    expect(result.results[1].error).toBe(injectedFailure);

    const firstIdentity = deriveEventIdentity(first);
    const lastIdentity = deriveEventIdentity(last);
    expect(await receiptCollection.findOne({ _id: failingIdentity })).toBeNull();
    expect(await historyCollection.findOne({ _id: failingIdentity })).toBeNull();
    expect(await receiptCollection.findOne({ _id: firstIdentity })).not.toBeNull();
    expect(await historyCollection.findOne({ _id: firstIdentity })).not.toBeNull();
    expect(await receiptCollection.findOne({ _id: lastIdentity })).not.toBeNull();
    expect(await historyCollection.findOne({ _id: lastIdentity })).not.toBeNull();
    expect(await receiptCollection.countDocuments({})).toBe(2);
    expect(await historyCollection.countDocuments({})).toBe(2);
  });
});
