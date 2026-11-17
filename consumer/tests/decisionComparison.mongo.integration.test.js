require("dotenv").config();
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");
const { MongoClient, Long } = require("mongodb");
const { EMPTY, GROUP, POSITIVE, decide, experimental, idOf, identity, reference, setupIndexes } = require("./decisionComparisonHarness");

const uri = getMongoIntegrationUri(process.env);
const describeMongo = uri ? describe : describe.skip;

describeMongo("isolated decision-store comparison", () => {
  jest.setTimeout(120000);
  let client, db, collections, raw;
  const variants = { reference, experimental };
  const item = identity("9007199254740993");
  const id = idOf(item);

  beforeAll(async () => {
    client = new MongoClient(uri);
    db = createMongoTestDatabase(client, "decision_comparison_test");
    await client.connect();
    collections = Object.fromEntries(Object.keys(variants).map((name) => [name, db.collection(name)]));
    raw = db.collection("legacy_raw");
    for (const collection of Object.values(collections)) await setupIndexes(collection);
  });
  afterAll(async () => {
    try { if (db) await dropMongoTestDatabase(db); } finally { if (client) await client.close(); }
  });
  beforeEach(async () => {
    await raw.deleteMany({});
    for (const collection of Object.values(collections)) await collection.deleteMany({});
  });

  function override(collection, methods) {
    return new Proxy(collection, {
      get(target, property) {
        if (property in methods) return methods[property];
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  test.each([["positive", POSITIVE, EMPTY], ["null", EMPTY, POSITIVE]])(
    "inserts, replays and preserves existing %s decision and BSON Long", async (_, initial, other) => {
      for (const [name, factory] of Object.entries(variants)) {
        const collection = collections[name];
        const store = factory(collection);
        const first = await decide(store, raw, item, initial);
        expect(first.alertCandidate).toEqual(initial.alertCandidate);
        expect(Long.isLong(first.offset)).toBe(true);
        expect(first.offset.toString()).toBe(item.offset);
        expect(await decide(store, raw, item, other)).toEqual(first);
        expect(await store.insertOriginal(item, other)).toEqual(first);
        expect(await collection.countDocuments()).toBe(1);
      }
    }
  );

  test.each([POSITIVE, EMPTY])("migrates a legacy raw decision and survives raw deletion", async (legacy) => {
    await raw.insertOne({ _id: id, ...legacy });
    for (const [name, factory] of Object.entries(variants)) {
      expect(await decide(factory(collections[name]), raw, item, POSITIVE)).toMatchObject(legacy);
    }
    await raw.deleteOne({ _id: id });
    for (const [name, factory] of Object.entries(variants)) {
      expect(await decide(factory(collections[name]), raw, item, POSITIVE)).toMatchObject(legacy);
    }
  });

  test("concurrent competing inserts return the persisted winner", async () => {
    for (const [name, factory] of Object.entries(variants)) {
      const store = factory(collections[name]);
      const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        store.insertOriginal(item, index % 2 ? POSITIVE : EMPTY)));
      const winner = await store.find(item);
      expect(results).toEqual(Array(10).fill(winner));
      expect([null, POSITIVE.alertCandidate]).toContainEqual(winner.alertCandidate);
      expect(await collections[name].countDocuments()).toBe(1);
    }
  });

  test("concurrent different groups cannot both own the identity", async () => {
    for (const [name, factory] of Object.entries(variants)) {
      const results = await Promise.allSettled([
        factory(collections[name], GROUP).insertOriginal(item, EMPTY),
        factory(collections[name], "other-group").insertOriginal(item, POSITIVE),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")[0].reason.message)
        .toContain("Conflicting consumer group ownership");
      expect(await collections[name].countDocuments()).toBe(1);
    }
  });

  test.each([
    { groupId: GROUP },
    { groupId: GROUP, topic: item.topic, partition: 0, offset: item.offset },
    { groupId: GROUP, topic: item.topic, partition: 0, offset: Long.fromString("5") },
    { groupId: "another-group", topic: item.topic, partition: 1, offset: Long.fromString(item.offset) },
  ])("rejects malformed stored metadata and preserves it", async (metadata) => {
    for (const [name, factory] of Object.entries(variants)) {
      const document = { _id: id, ...EMPTY, ...metadata };
      await collections[name].insertOne(document);
      await expect(factory(collections[name]).find(item)).rejects.toThrow("Invalid alert decision metadata");
      await expect(factory(collections[name]).insertOriginal(item, POSITIVE)).rejects.toThrow("Invalid alert decision metadata");
      expect(await collections[name].findOne({ _id: id }, { promoteLongs: false })).toEqual(document);
    }
  });

  test("rejects malformed stored decisions without overwriting them", async () => {
    for (const [name, factory] of Object.entries(variants)) {
      await collections[name].insertOne({ _id: id, groupId: GROUP, topic: item.topic, partition: 0,
        offset: Long.fromString(item.offset), previousPrice: null, percentChange: 0 });
      await expect(factory(collections[name]).find(item)).rejects.toThrow("Invalid persisted alert decision");
      await expect(factory(collections[name]).insertOriginal(item, EMPTY)).rejects.toThrow("Invalid persisted alert decision");
    }
  });

  test("preserves metadata-free legacy decisions and rejects conflicting ownership", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [name, factory] of Object.entries(variants)) {
        const collection = collections[name];
        await collection.insertOne({ _id: id, ...EMPTY });
        expect(await factory(collection).find(item)).toEqual({ _id: id, ...EMPTY });
        expect(await factory(collection).insertOriginal(item, POSITIVE)).toEqual({ _id: id, ...EMPTY });
        await collection.deleteOne({ _id: id });
        await factory(collection, "other-group").insertOriginal(item, EMPTY);
        await expect(factory(collection).find(item)).rejects.toThrow("Conflicting consumer group ownership");
        await expect(factory(collection).insertOriginal(item, POSITIVE)).rejects.toThrow("Conflicting consumer group ownership");
      }
      expect(warning).toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });

  test.each(["read", "write", "ambiguous", "duplicate"])("handles injected %s failures and retry", async (mode) => {
    for (const [name, factory] of Object.entries(variants)) {
      const collection = collections[name];
      const failure = Object.assign(new Error(`injected ${mode}`), mode === "duplicate" ? { code: 11000 } : {});
      const method = name === "reference" ? "findOneAndUpdate" : "updateOne";
      const proxy = override(collection, mode === "read"
        ? { findOne: async () => { throw failure; } }
        : { [method]: async (...args) => {
            if (mode === "ambiguous" || mode === "duplicate") await collection[method](...args);
            throw failure;
          } });
      if (mode === "read") {
        await expect(factory(proxy).find(item)).rejects.toBe(failure);
      } else if (mode === "duplicate") {
        expect(await factory(proxy).insertOriginal(item, EMPTY)).toMatchObject(EMPTY);
      } else {
        await expect(factory(proxy).insertOriginal(item, EMPTY)).rejects.toBe(failure);
      }
      if (mode === "ambiguous" || mode === "duplicate") {
        expect(await factory(collection).find(item)).toMatchObject(EMPTY);
        expect(await factory(collection).insertOriginal(item, POSITIVE)).toMatchObject(EMPTY);
      } else {
        expect(await collection.findOne({ _id: id })).toBeNull();
        expect(await factory(collection).insertOriginal(item, POSITIVE)).toMatchObject(POSITIVE);
      }
    }
  });

  test("missing race winner propagates duplicate error and matched-read failure is explicit", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: 11000 });
    for (const [name, factory] of Object.entries(variants)) {
      const collection = collections[name];
      const method = name === "reference" ? "findOneAndUpdate" : "updateOne";
      const proxy = override(collection, { [method]: async () => { throw duplicate; } });
      await expect(factory(proxy).insertOriginal(item, EMPTY)).rejects.toBe(duplicate);
    }
    const collection = collections.experimental;
    await experimental(collection).insertOriginal(item, EMPTY);
    const proxy = override(collection, { findOne: async () => { throw new Error("follow-up read failed"); } });
    await expect(experimental(proxy).insertOriginal(item, POSITIVE)).rejects.toThrow("follow-up read failed");
  });

  test("decision is saved before simulated raw/later-stage failure and reused on retry", async () => {
    for (const [name, factory] of Object.entries(variants)) {
      const store = factory(collections[name]);
      const first = await decide(store, raw, item, EMPTY);
      expect(first).toMatchObject(EMPTY); // interruption before any raw write
      expect(await decide(store, raw, item, POSITIVE)).toEqual(first);
      await raw.updateOne({ _id: id }, { $setOnInsert: { ...EMPTY } }, { upsert: true });
      // Simulated later failure and retention pruning leave the decision intact.
      await raw.deleteOne({ _id: id });
      expect(await decide(store, raw, item, POSITIVE)).toEqual(first);
    }
  });

  test("simulated decision removal loses recovery only when legacy raw is also absent", async () => {
    for (const [name, factory] of Object.entries(variants)) {
      const store = factory(collections[name]);
      await store.insertOriginal(item, EMPTY);
      await raw.updateOne({ _id: id }, { $set: EMPTY }, { upsert: true });
      await collections[name].deleteOne({ _id: id });
      expect(await decide(store, raw, item, POSITIVE)).toMatchObject(EMPTY);
      await collections[name].deleteOne({ _id: id });
      await raw.deleteOne({ _id: id });
      expect(await decide(store, raw, item, POSITIVE)).toMatchObject(POSITIVE);
    }
  });

  test("removal between update and follow-up read exposes non-equivalence", async () => {
    for (const [name, factory] of Object.entries(variants)) {
      const collection = collections[name];
      await factory(collection).insertOriginal(item, EMPTY);
      const method = name === "reference" ? "findOneAndUpdate" : "updateOne";
      const proxy = override(collection, { [method]: async (...args) => {
        const result = await collection[method](...args);
        await collection.deleteOne({ _id: id });
        return result;
      } });
      if (name === "reference") {
        expect(await factory(proxy).insertOriginal(item, POSITIVE)).toMatchObject(EMPTY);
      } else {
        await expect(factory(proxy).insertOriginal(item, POSITIVE)).rejects.toThrow("Matched decision disappeared");
      }
      expect(await collection.findOne({ _id: id })).toBeNull();
    }
  });

  test("noncanonical BSON input is explicitly rejected by the experimental path", async () => {
    const noncanonical = { ...POSITIVE, alertCandidate: { ...POSITIVE.alertCandidate, extra: undefined } };
    const result = await reference(collections.reference).insertOriginal(item, noncanonical);
    expect(result.alertCandidate.extra == null).toBe(true);
    await expect(experimental(collections.experimental).insertOriginal(item, noncanonical))
      .rejects.toThrow("not BSON-round-trip equivalent");
    expect(await collections.experimental.countDocuments()).toBe(0);
  });
});
