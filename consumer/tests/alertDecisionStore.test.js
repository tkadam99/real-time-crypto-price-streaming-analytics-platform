const { createAlertDecisionStore } = require("../src/alertDecisionStore");
const { buildAlert } = require("../src/analytics");

const identity = { topic: "crypto-prices", partition: 0, offset: "9007199254740993" };
const id = JSON.stringify([identity.topic, identity.partition, identity.offset]);
const positive = {
  alertCandidate: buildAlert(
    "BTC-USD", 2, 102, 100, "2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z", 60000
  ),
  previousPrice: 100,
  percentChange: 2,
};
const noAlert = { alertCandidate: null, previousPrice: null, percentChange: 0 };

describe("alert decision store", () => {
  let collection;
  let store;

  beforeEach(() => {
    collection = { findOne: jest.fn(), findOneAndUpdate: jest.fn() };
    store = createAlertDecisionStore(collection);
  });

  it("inserts and returns the complete positive original decision", async () => {
    collection.findOneAndUpdate.mockResolvedValue({ _id: id, ...positive });
    await expect(store.insertOriginal(identity, positive)).resolves.toEqual({ _id: id, ...positive });
    expect(collection.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: id },
      { $setOnInsert: { _id: id, ...positive } },
      { upsert: true, returnDocument: "after" }
    );
  });

  it("distinguishes a missing decision from a persisted null decision", async () => {
    collection.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: id, ...noAlert });
    await expect(store.find(identity)).resolves.toBeNull();
    await expect(store.find(identity)).resolves.toEqual({ _id: id, ...noAlert });
  });

  it("returns the persisted winner without overwriting on duplicate insertion", async () => {
    collection.findOneAndUpdate.mockResolvedValue({ _id: id, ...noAlert });
    await expect(store.insertOriginal(identity, positive)).resolves.toEqual({ _id: id, ...noAlert });
  });

  it("returns the winner of a duplicate-key race", async () => {
    collection.findOneAndUpdate.mockRejectedValue(Object.assign(new Error("duplicate"), { code: 11000 }));
    collection.findOne.mockResolvedValue({ _id: id, ...positive });
    await expect(store.insertOriginal(identity, noAlert)).resolves.toEqual({ _id: id, ...positive });
    expect(collection.findOne).toHaveBeenCalledWith({ _id: id });
  });

  it("propagates a duplicate-key error if the requested winner is absent", async () => {
    const failure = Object.assign(new Error("duplicate elsewhere"), { code: 11000 });
    collection.findOneAndUpdate.mockRejectedValue(failure);
    collection.findOne.mockResolvedValue(null);
    await expect(store.insertOriginal(identity, noAlert)).rejects.toBe(failure);
  });

  it("propagates read failures, including during race resolution", async () => {
    const failure = new Error("read failed");
    collection.findOne.mockRejectedValue(failure);
    await expect(store.find(identity)).rejects.toBe(failure);
    collection.findOneAndUpdate.mockRejectedValue(Object.assign(new Error("duplicate"), { code: 11000 }));
    await expect(store.insertOriginal(identity, positive)).rejects.toBe(failure);
  });

  it("propagates unexpected write failures", async () => {
    const failure = new Error("write failed");
    collection.findOneAndUpdate.mockRejectedValue(failure);
    await expect(store.insertOriginal(identity, positive)).rejects.toBe(failure);
  });

  it("propagates an ambiguous write and returns the persisted winner on retry", async () => {
    const failure = new Error("write acknowledgement lost");
    collection.findOneAndUpdate.mockRejectedValueOnce(failure).mockResolvedValueOnce({ _id: id, ...positive });
    await expect(store.insertOriginal(identity, positive)).rejects.toBe(failure);
    await expect(store.insertOriginal(identity, noAlert)).resolves.toEqual({ _id: id, ...positive });
  });

  it("rejects malformed input before writing", async () => {
    await expect(store.insertOriginal(identity, { ...noAlert, alertCandidate: {} }))
      .rejects.toThrow("Invalid alert decision input");
    await expect(store.insertOriginal(identity, null)).rejects.toThrow("Invalid alert decision input");
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { _id: id, previousPrice: null, percentChange: 0 },
    { _id: id, alertCandidate: undefined, previousPrice: null, percentChange: 0 },
    { _id: id, alertCandidate: {}, previousPrice: null, percentChange: 0 },
    { _id: id, alertCandidate: null, previousPrice: null, percentChange: NaN },
    { _id: "other", ...noAlert },
  ])("rejects malformed persisted decisions", async (document) => {
    collection.findOne.mockResolvedValue(document);
    await expect(store.find(identity)).rejects.toThrow("Invalid persisted alert decision");
    collection.findOneAndUpdate.mockResolvedValue(document);
    await expect(store.insertOriginal(identity, noAlert)).rejects.toThrow("Invalid persisted alert decision");
  });

  it("preserves large offsets and distinguishes topics, partitions and offsets", async () => {
    collection.findOne.mockResolvedValue(null);
    const identities = [
      identity,
      { ...identity, topic: "other" },
      { ...identity, partition: 1 },
      { ...identity, offset: "9007199254740994" },
      { ...identity, offset: "9223372036854775807" },
    ];
    for (const item of identities) await store.find(item);
    expect(new Set(collection.findOne.mock.calls.map(([filter]) => filter._id)).size).toBe(5);
    expect(collection.findOne).toHaveBeenCalledWith({ _id: id });
  });

  it.each([
    null,
    { topic: "", partition: 0, offset: "0" },
    { topic: "t", partition: -1, offset: "0" },
    { topic: "t", partition: 0, offset: 9007199254740993 },
    { topic: "t", partition: 0, offset: "01" },
    { topic: "t", partition: 0, offset: "9223372036854775808" },
  ])("rejects invalid Kafka identities before database access", async (invalid) => {
    await expect(store.find(invalid)).rejects.toThrow("Invalid Kafka event identity");
    expect(collection.findOne).not.toHaveBeenCalled();
  });
});
