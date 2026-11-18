const { createExactCountRetention } = require("./retentionExactCountHarness");

function collectionWithResults(results, count = 0) {
  const collection = {
    find: jest.fn(() => {
      const cursor = {
        sort: jest.fn(() => cursor),
        skip: jest.fn(() => cursor),
        limit: jest.fn(() => cursor),
        project: jest.fn(() => cursor),
        toArray: jest.fn(async () => results.shift()),
      };
      return cursor;
    }),
    countDocuments: jest.fn().mockResolvedValue(count),
    updateOne: jest.fn(),
    deleteMany: jest.fn(),
  };
  return collection;
}

const record = { _id: "event", symbol: "BTC-USD", timestamp: "2025-01-01", receivedAt: "2025-01-01" };

test("invalidates an unacknowledged upsert and uses the full scan on retry", async () => {
  const collection = collectionWithResults([[], []]);
  collection.updateOne
    .mockResolvedValueOnce({ acknowledged: false })
    .mockResolvedValueOnce({ acknowledged: true, upsertedCount: 0, matchedCount: 1 });
  const experiment = createExactCountRetention(collection, 1);
  await experiment.initialize(record.symbol);
  await expect(experiment.process(record)).rejects.toThrow("Uncertain raw-event upsert outcome");
  expect((await experiment.process(record)).path).toBe("fallback");
  expect(collection.find).toHaveBeenCalledTimes(2);
});

test("invalidates an unacknowledged deletion and uses the full scan on retry", async () => {
  const collection = collectionWithResults([[], [{ _id: "oldest" }], []], 1);
  collection.updateOne
    .mockResolvedValueOnce({ acknowledged: true, upsertedCount: 1, matchedCount: 0 })
    .mockResolvedValueOnce({ acknowledged: true, upsertedCount: 0, matchedCount: 1 });
  collection.deleteMany.mockResolvedValue({ acknowledged: false });
  const experiment = createExactCountRetention(collection, 1);
  await experiment.initialize(record.symbol);
  await expect(experiment.process(record)).rejects.toThrow("Uncertain retention deletion outcome");
  expect((await experiment.process(record)).path).toBe("fallback");
  expect(collection.find).toHaveBeenCalledTimes(3);
});

test("does not accept an unacknowledged fallback deletion", async () => {
  const collection = collectionWithResults([[{ _id: "oldest" }], []]);
  collection.deleteMany.mockResolvedValue({ acknowledged: false });
  collection.updateOne.mockResolvedValue({ acknowledged: true, upsertedCount: 0, matchedCount: 1 });
  const experiment = createExactCountRetention(collection, 1);
  await expect(experiment.initialize(record.symbol)).rejects.toThrow("Uncertain fallback deletion outcome");
  expect((await experiment.process(record)).path).toBe("fallback");
});

test("rejects overlapping operations and invalidation during an active operation", async () => {
  const collection = collectionWithResults([[]]);
  let release;
  collection.updateOne.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const experiment = createExactCountRetention(collection, 1);
  await experiment.initialize(record.symbol);
  const pending = experiment.process(record);
  await expect(experiment.process(record)).rejects.toThrow("Concurrent retention");
  expect(() => experiment.invalidate(record.symbol)).toThrow("active retention");
  release({ acknowledged: true, upsertedCount: 1, matchedCount: 0 });
  expect((await pending).path).toBe("exact-count");
});
