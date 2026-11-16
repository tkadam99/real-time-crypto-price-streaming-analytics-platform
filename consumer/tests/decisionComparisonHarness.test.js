const { experimental, identity, EMPTY } = require("./decisionComparisonHarness");

test("experimental store rejects unacknowledged or inconsistent upsert responses", async () => {
  const collection = { updateOne: jest.fn(), findOne: jest.fn() };
  const store = experimental(collection);
  const item = identity(1);
  collection.updateOne.mockResolvedValueOnce({ acknowledged: false });
  await expect(store.insertOriginal(item, EMPTY)).rejects.toThrow("Unacknowledged decision write");
  collection.updateOne.mockResolvedValueOnce({ acknowledged: true, upsertedCount: 1, matchedCount: 0, upsertedId: "wrong" });
  await expect(store.insertOriginal(item, EMPTY)).rejects.toThrow("Unexpected decision write result");
  expect(collection.findOne).not.toHaveBeenCalled();
});

test("experimental store validates identity and input before any write", async () => {
  const collection = { updateOne: jest.fn(), findOne: jest.fn() };
  const store = experimental(collection);
  await expect(store.insertOriginal({ topic: "t", partition: 0, offset: "01" }, EMPTY)).rejects.toThrow("Invalid Kafka event identity");
  await expect(store.insertOriginal(identity(1), { ...EMPTY, alertCandidate: {} })).rejects.toThrow("Invalid alert decision input");
  expect(collection.updateOne).not.toHaveBeenCalled();
});
