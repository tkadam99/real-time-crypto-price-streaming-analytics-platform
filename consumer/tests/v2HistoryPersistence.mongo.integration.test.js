require("dotenv").config();
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");
const { MongoClient } = require("mongodb");
const { createEnvelope } = require("../v2/eventContract");
const { persistHistoryEvent } = require("../v2/historyPersistence");

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
      "V2 history integration tests require mongodb://127.0.0.1:27019/admin?directConnection=true.",
    );
  }
}

assertV2MongoEndpoint(integrationUri);
const describeMongo = integrationUri ? describe : describe.skip;

const event = {
  symbol: "BTC-USD",
  price: 105.5,
  timestamp: "2026-01-01T00:01:00+00:00",
};
const source = {
  clusterId: "cluster-a",
  topicGenerationId: "generation-1",
  topic: "crypto-prices",
  partition: 0,
  offset: "9007199254740993",
};
const envelope = createEnvelope(event, source);
const insertedAt = new Date("2026-01-02T03:04:05.000Z");

describeMongo("V2 history persistence MongoDB transactions", () => {
  jest.setTimeout(30000);

  let client;
  let db;
  let historyCollection;
  let receiptCollection;

  async function persist(eventEnvelope = envelope, options = {}) {
    return persistHistoryEvent({
      client,
      historyCollection,
      receiptCollection,
      envelope: eventEnvelope,
      insertedAt,
      ...options,
    });
  }

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
    const primaryMembers = status.members.filter(
      (member) => member.name === "v2-mongodb:27017" &&
        member.stateStr === "PRIMARY" &&
        member.self === true,
    );
    expect(primaryMembers).toHaveLength(1);

    db = createMongoTestDatabase(client, "v2_history_test");
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

  test("commits one matching receipt and history document atomically", async () => {
    const result = await persist();

    expect(result.status).toBe("inserted");
    expect(await receiptCollection.countDocuments({})).toBe(1);
    expect(await historyCollection.countDocuments({})).toBe(1);

    const receipt = await receiptCollection.findOne({ _id: result.eventIdentity });
    const history = await historyCollection.findOne({ _id: result.eventIdentity });
    expect(receipt).toMatchObject({ _id: result.eventIdentity, source });
    expect(history).toMatchObject({
      _id: result.eventIdentity,
      symbol: event.symbol,
      price: event.price,
      timestamp: event.timestamp,
      source,
      createdAt: insertedAt,
    });
    expect(history.source.offset).toBe("9007199254740993");
  });

  test("returns replay for an existing receipt without duplicating documents", async () => {
    const first = await persist();
    const replay = await persist();

    expect(first.status).toBe("inserted");
    expect(replay).toEqual({ status: "replay", eventIdentity: first.eventIdentity });
    expect(await receiptCollection.countDocuments({})).toBe(1);
    expect(await historyCollection.countDocuments({})).toBe(1);
  });

  test("serializes concurrent delivery into one insertion and a confirmed replay", async () => {
    const outcomes = await Promise.allSettled([persist(), persist()]);
    const transientConflicts = outcomes.filter((outcome) => {
      if (outcome.status !== "rejected") return false;
      const error = outcome.reason;
      return typeof error.hasErrorLabel === "function" &&
        error.hasErrorLabel("TransientTransactionError");
    });

    expect(transientConflicts).toHaveLength(0);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    const results = outcomes.map((outcome) => outcome.value);
    expect(results.map((result) => result.status).sort()).toEqual(["inserted", "replay"]);
    expect(results[0].eventIdentity).toBe(results[1].eventIdentity);
    expect(await receiptCollection.countDocuments({})).toBe(1);
    expect(await historyCollection.countDocuments({})).toBe(1);
  });

  test("aborts the receipt when the history insert fails", async () => {
    const failure = new Error("Induced history insert failure.");
    const failingHistoryCollection = new Proxy(historyCollection, {
      get(target, property) {
        if (property === "insertOne") {
          return async () => {
            throw failure;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(persistHistoryEvent({
      client,
      historyCollection: failingHistoryCollection,
      receiptCollection,
      envelope,
      insertedAt,
    })).rejects.toBe(failure);

    expect(await receiptCollection.countDocuments({})).toBe(0);
    expect(await historyCollection.countDocuments({})).toBe(0);
  });

  test("does not recreate history when a durable receipt remains after history deletion", async () => {
    const first = await persist();
    await expect(historyCollection.deleteOne({ _id: first.eventIdentity }))
      .resolves.toMatchObject({ deletedCount: 1 });

    const replay = await persist();

    expect(replay).toEqual({ status: "replay", eventIdentity: first.eventIdentity });
    expect(await receiptCollection.countDocuments({})).toBe(1);
    expect(await historyCollection.findOne({ _id: first.eventIdentity })).toBeNull();
  });
});
