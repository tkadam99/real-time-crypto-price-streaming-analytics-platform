require("dotenv").config();
const { MongoClient } = require("mongodb");
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");
const { createIndexes, event, ordered, algorithms: { reference }, validateRetention } = require("./retentionHarness");
const { createExactCountRetention } = require("./retentionExactCountHarness");

const uri = getMongoIntegrationUri(process.env);
const describeMongo = uri ? describe : describe.skip;

describeMongo("guarded exact-count retention experiment", () => {
  jest.setTimeout(120000);
  const target = 3;
  let client, db, baseline, candidate, experiment;

  async function upsert(collection, document) {
    const { _id, ...fields } = document;
    return collection.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
  }

  async function compareStep(document) {
    const result = await upsert(baseline, document);
    const before = await ordered(baseline);
    await reference(baseline, document.symbol, target);
    const candidateResult = await experiment.process(document);
    const expected = await ordered(baseline);
    validateRetention(before, expected, document.symbol, target);
    expect(await ordered(candidate)).toEqual(expected);
    expect(candidateResult.upserted).toBe(result.upsertedCount);
    return candidateResult;
  }

  beforeAll(async () => {
    client = new MongoClient(uri);
    db = createMongoTestDatabase(client, "retention_exact_test");
    await client.connect();
    baseline = db.collection("baseline");
    candidate = db.collection("candidate");
    await createIndexes(baseline);
    await createIndexes(candidate);
  });

  afterAll(async () => {
    try { if (db) await dropMongoTestDatabase(db); } finally { if (client) await client.close(); }
  });

  beforeEach(async () => {
    await baseline.deleteMany({});
    await candidate.deleteMany({});
    experiment = createExactCountRetention(candidate, target);
  });

  test("matches new, matched, late, tied, replayed and reinserted records after each operation", async () => {
    await experiment.initialize("BTC-USD");
    await experiment.initialize("ETH-USD");
    const tiedTime = "2025-01-01T00:00:10.000Z";
    const receipt = "2025-01-01T00:00:11.000Z";
    const first = event("BTC-USD", 10);
    const late = event("BTC-USD", 1);
    const sequence = [
      first, event("ETH-USD", 4), event("BTC-USD", 11), first,
      event("BTC-USD", 12),
      event("BTC-USD", 13, { timestamp: tiedTime, receivedAt: receipt }),
      event("BTC-USD", 14, { timestamp: tiedTime, receivedAt: receipt }),
      late, late, event("BTC-USD", 12),
      event("BTC-USD", 20, { timestamp: "2025-01-01T01:00:00+01:00", receivedAt: receipt }),
    ];
    const results = [];
    for (const document of sequence) results.push(await compareStep(document));
    expect(results[0].upserted).toBe(1);
    expect(results[3].upserted).toBe(0);
    expect(results[7].upserted).toBe(1);
    expect(results[8].upserted).toBe(1);
    expect(results.every((result) => result.path === "exact-count")).toBe(true);
  });

  test("rebuilds after restart and explicit invalidation", async () => {
    for (let index = 0; index < target; index++) await compareStep(event("BTC-USD", index));
    experiment = createExactCountRetention(candidate, target);
    expect((await compareStep(event("BTC-USD", 2))).path).toBe("fallback");

    const external = event("BTC-USD", -1);
    await baseline.insertOne(external);
    await candidate.insertOne(external);
    experiment.invalidate("BTC-USD");
    expect((await compareStep(event("BTC-USD", 2))).path).toBe("fallback");
  });

  test.each(["read", "delete", "partial"])(
    "invalidates after a %s failure and retries through the full scan", async (failure) => {
      for (let index = 0; index < target; index++) await compareStep(event("BTC-USD", index));
      const document = event("BTC-USD", 10);
      const error = new Error(`injected ${failure}`);
      function hooks(collection) {
        if (failure === "read") return { beforeRead: async () => { throw error; } };
        return {
          beforeDelete: async (filter) => {
            if (failure === "partial") await collection.deleteMany(filter);
            throw error;
          },
        };
      }
      await upsert(baseline, document);
      await expect(reference(baseline, document.symbol, target, hooks(baseline))).rejects.toBe(error);
      await expect(experiment.process(document, hooks(candidate))).rejects.toBe(error);
      expect(await ordered(candidate)).toEqual(await ordered(baseline));
      expect((await compareStep(document)).path).toBe("fallback");
    }
  );

  test("invalidates an uncertain upsert outcome before retrying", async () => {
    await experiment.initialize("BTC-USD");
    const document = event("BTC-USD", 1);
    const error = new Error("injected post-upsert failure");
    await upsert(baseline, document);
    await expect(experiment.process(document, {
      afterUpsert: async () => { throw error; },
    })).rejects.toBe(error);
    expect((await compareStep(document)).path).toBe("fallback");
  });

  test("an undetected external insert breaks the exclusive-writer assumption", async () => {
    for (let index = 0; index < target; index++) await compareStep(event("BTC-USD", index));
    const external = event("BTC-USD", -1);
    await baseline.insertOne(external);
    await candidate.insertOne(external);
    const next = event("BTC-USD", 10);
    await upsert(baseline, next);
    await reference(baseline, next.symbol, target);
    expect((await experiment.process(next)).path).toBe("exact-count");
    expect(await baseline.countDocuments({ symbol: "BTC-USD" })).toBe(target);
    expect(await candidate.countDocuments({ symbol: "BTC-USD" })).toBe(target + 1);
    expect(await ordered(candidate)).not.toEqual(await ordered(baseline));
  });
});
