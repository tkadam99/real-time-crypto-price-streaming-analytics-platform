const {
  createEnvelope,
  serializeSourceIdentity,
} = require("../v2/eventContract");
const { persistHistoryEvent } = require("../v2/historyPersistence");

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
const eventIdentity = serializeSourceIdentity(source);

function duplicateIdError(identity = eventIdentity) {
  return Object.assign(new Error("duplicate key"), {
    code: 11000,
    keyPattern: { _id: 1 },
    keyValue: { _id: identity },
  });
}

function createHarness({
  existingReceipt,
  receiptInsertError,
  historyInsertError,
} = {}) {
  const state = {
    receipts: new Map(),
    history: new Map(),
  };
  if (existingReceipt) state.receipts.set(eventIdentity, existingReceipt);

  const receiptCollection = {
    findOne: jest.fn(async ({ _id }) => state.receipts.get(_id) || null),
    insertOne: jest.fn(async (document) => {
      if (receiptInsertError) throw receiptInsertError;
      if (state.receipts.has(document._id)) throw duplicateIdError(document._id);
      state.receipts.set(document._id, document);
      return { acknowledged: true };
    }),
  };
  const historyCollection = {
    insertOne: jest.fn(async (document) => {
      if (historyInsertError) throw historyInsertError;
      if (state.history.has(document._id)) throw duplicateIdError(document._id);
      state.history.set(document._id, document);
      return { acknowledged: true };
    }),
  };
  const session = {
    withTransaction: jest.fn(async (callback) => {
      const before = {
        receipts: new Map(state.receipts),
        history: new Map(state.history),
      };
      try {
        return await callback();
      } catch (error) {
        state.receipts = before.receipts;
        state.history = before.history;
        throw error;
      }
    }),
    endSession: jest.fn().mockResolvedValue(),
  };
  const client = { startSession: jest.fn(() => session) };

  return { client, historyCollection, receiptCollection, session, state };
}

function persist(harness, options = {}) {
  return persistHistoryEvent({
    client: harness.client,
    historyCollection: harness.historyCollection,
    receiptCollection: harness.receiptCollection,
    envelope,
    insertedAt,
    ...options,
  });
}

test("inserts a durable receipt and corresponding history in one transaction", async () => {
  const harness = createHarness();
  const order = [];
  harness.receiptCollection.findOne.mockImplementation(async (...args) => {
    order.push("findReceipt");
    return harness.state.receipts.get(args[0]._id) || null;
  });
  harness.receiptCollection.insertOne.mockImplementation(async (document, options) => {
    order.push("insertReceipt");
    expect(options.session).toBe(harness.session);
    harness.state.receipts.set(document._id, document);
    return { acknowledged: true };
  });
  harness.historyCollection.insertOne.mockImplementation(async (document, options) => {
    order.push("insertHistory");
    expect(options.session).toBe(harness.session);
    harness.state.history.set(document._id, document);
    return { acknowledged: true };
  });

  const result = await persist(harness);

  expect(result).toEqual({ status: "inserted", eventIdentity });
  expect(order).toEqual(["findReceipt", "insertReceipt", "insertHistory"]);
  expect(harness.state.receipts.get(eventIdentity)).toEqual({
    _id: eventIdentity,
    source,
  });
  expect(harness.state.history.get(eventIdentity)).toMatchObject({
    _id: eventIdentity,
    source,
    timestamp: event.timestamp,
    createdAt: insertedAt,
  });
  expect(harness.state.history.get(eventIdentity).source.offset).toBe("9007199254740993");
  expect(harness.session.withTransaction).toHaveBeenCalledTimes(1);
  expect(harness.session.endSession).toHaveBeenCalledTimes(1);
});

test("a durable receipt prevents history recreation after the history document expires", async () => {
  const receipt = { _id: eventIdentity, source };
  const harness = createHarness({ existingReceipt: receipt });

  await expect(persist(harness)).resolves.toEqual({ status: "replay", eventIdentity });

  expect(harness.receiptCollection.findOne).toHaveBeenCalledWith(
    { _id: eventIdentity },
    { session: harness.session },
  );
  expect(harness.receiptCollection.insertOne).not.toHaveBeenCalled();
  expect(harness.historyCollection.insertOne).not.toHaveBeenCalled();
  expect(harness.state.history.size).toBe(0);
});

test("classifies a concurrent _id duplicate as replay only after confirming its receipt", async () => {
  const receipt = { _id: eventIdentity, source };
  const harness = createHarness();
  harness.receiptCollection.findOne
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(receipt);
  harness.receiptCollection.insertOne.mockRejectedValue(duplicateIdError());

  await expect(persist(harness)).resolves.toEqual({ status: "replay", eventIdentity });

  expect(harness.historyCollection.insertOne).not.toHaveBeenCalled();
  expect(harness.receiptCollection.findOne).toHaveBeenCalledTimes(2);
  expect(harness.receiptCollection.findOne.mock.calls[1]).toEqual([{ _id: eventIdentity }]);
  expect(harness.session.endSession).toHaveBeenCalledTimes(1);
});

test("does not classify unrelated duplicate-key errors as replays", async () => {
  const unrelatedDuplicate = Object.assign(new Error("unrelated unique index"), {
    code: 11000,
    keyPattern: { symbol: 1 },
    keyValue: { symbol: "BTC-USD" },
  });
  const harness = createHarness({ receiptInsertError: unrelatedDuplicate });

  await expect(persist(harness)).rejects.toBe(unrelatedDuplicate);

  expect(harness.receiptCollection.findOne).toHaveBeenCalledTimes(1);
  expect(harness.historyCollection.insertOne).not.toHaveBeenCalled();
  expect(harness.session.endSession).toHaveBeenCalledTimes(1);
});

test.each(["receipt", "history"])("aborts both writes when the %s write fails", async (failedWrite) => {
  const failure = new Error(`${failedWrite} write failed`);
  const harness = createHarness({
    receiptInsertError: failedWrite === "receipt" ? failure : undefined,
    historyInsertError: failedWrite === "history" ? failure : undefined,
  });

  await expect(persist(harness)).rejects.toBe(failure);

  expect(harness.state.receipts.size).toBe(0);
  expect(harness.state.history.size).toBe(0);
  if (failedWrite === "receipt") {
    expect(harness.historyCollection.insertOne).not.toHaveBeenCalled();
  } else {
    expect(harness.receiptCollection.insertOne).toHaveBeenCalledTimes(1);
    expect(harness.historyCollection.insertOne).toHaveBeenCalledTimes(1);
  }
  expect(harness.session.endSession).toHaveBeenCalledTimes(1);
});

test("does not hide an _id duplicate if no durable receipt exists", async () => {
  const duplicate = duplicateIdError();
  const harness = createHarness({ receiptInsertError: duplicate });

  await expect(persist(harness)).rejects.toBe(duplicate);

  expect(harness.receiptCollection.findOne).toHaveBeenCalledTimes(2);
  expect(harness.session.endSession).toHaveBeenCalledTimes(1);
});
