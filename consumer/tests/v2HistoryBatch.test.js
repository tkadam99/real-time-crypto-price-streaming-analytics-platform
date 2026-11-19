jest.mock("../v2/historyPersistence", () => ({
  persistHistoryEvent: jest.fn(),
}));

const { createEnvelope } = require("../v2/eventContract");
const { deriveEventIdentity } = require("../v2/historyContract");
const { persistHistoryEvent } = require("../v2/historyPersistence");
const { persistHistoryBatch } = require("../v2/historyBatch");

const event = {
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
const insertedAt = new Date("2026-01-02T03:04:05.000Z");

function envelope(offset, overrides = {}) {
  return createEnvelope(
    { ...event, ...overrides.event },
    { ...baseSource, offset: String(offset), ...overrides.source },
  );
}

function batch(envelopes, options = {}) {
  return persistHistoryBatch({
    client: { startSession: jest.fn() },
    historyCollection: {},
    receiptCollection: {},
    envelopes,
    ...options,
  });
}

beforeEach(() => {
  persistHistoryEvent.mockReset();
});

test.each([
  ["non-array inputs", { envelopes: null }],
  ["batchSize below range", { envelopes: [], batchSize: 0 }],
  ["batchSize above range", { envelopes: [], batchSize: 101 }],
  ["fractional batchSize", { envelopes: [], batchSize: 1.5 }],
  ["concurrency below range", { envelopes: [], concurrency: 0 }],
  ["concurrency above range", { envelopes: [], concurrency: 5 }],
  ["fractional concurrency", { envelopes: [], concurrency: 1.5 }],
  ["invalid insertion time", { envelopes: [], insertedAt: "not-a-date" }],
])("validates %s before attempting persistence", async (_label, options) => {
  await expect(batch(envelope(1), options)).rejects.toThrow();
  expect(persistHistoryEvent).not.toHaveBeenCalled();
});

test("rejects more than 100 envelopes before any writes", async () => {
  await expect(batch(Array.from({ length: 101 }, (_, index) => envelope(index))))
    .rejects.toThrow("cannot exceed 100 envelopes");
  expect(persistHistoryEvent).not.toHaveBeenCalled();
});

test("returns input-ordered mixed outcomes and isolates invalid and failed events", async () => {
  const invalidEnvelope = { ...envelope(11), price: 0 };
  const inputs = [envelope(10), invalidEnvelope, envelope(12), envelope(13)];
  const writeFailure = new Error("transaction failed");
  persistHistoryEvent.mockImplementation(async ({ envelope: item }) => {
    if (item.source.offset === "12") {
      return { status: "replay", eventIdentity: deriveEventIdentity(item) };
    }
    if (item.source.offset === "13") throw writeFailure;
    return { status: "inserted", eventIdentity: deriveEventIdentity(item) };
  });

  const result = await batch(inputs, { insertedAt, batchSize: 4, concurrency: 2 });

  expect(result).toMatchObject({
    inserted: 1,
    replay: 1,
    failed: 2,
    total: 4,
  });
  expect(result.results.map(({ index, status }) => [index, status])).toEqual([
    [0, "inserted"],
    [1, "failed"],
    [2, "replay"],
    [3, "failed"],
  ]);
  expect(result.results[1].error).toBeInstanceOf(Error);
  expect(result.results[3].error).toBe(writeFailure);
  expect(persistHistoryEvent).toHaveBeenCalledTimes(3);
  expect(persistHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({
    envelope: inputs[0],
    insertedAt,
  }));
  expect(persistHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({
    envelope: inputs[2],
    insertedAt,
  }));
});

test("keeps exact source offsets and identities when delegating to transactional persistence", async () => {
  const input = envelope("9007199254740993");
  persistHistoryEvent.mockImplementation(async ({ envelope: item }) => ({
    status: "inserted",
    eventIdentity: deriveEventIdentity(item),
  }));

  const result = await batch([input], { insertedAt });

  expect(persistHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({
    envelope: input,
    insertedAt,
  }));
  expect(result.results[0].eventIdentity).toBe(deriveEventIdentity(input));
  expect(result.results[0].eventIdentity).toContain('"9007199254740993"');
});

test("never exceeds the configured concurrency while processing bounded chunks", async () => {
  let active = 0;
  let maxActive = 0;
  persistHistoryEvent.mockImplementation(async ({ envelope: item }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    return { status: "inserted", eventIdentity: deriveEventIdentity(item) };
  });

  const result = await batch(
    Array.from({ length: 11 }, (_, index) => envelope(index)),
    { batchSize: 4, concurrency: 3 },
  );

  expect(maxActive).toBe(3);
  expect(result.inserted).toBe(11);
  expect(persistHistoryEvent).toHaveBeenCalledTimes(11);
});

test("does not reclassify persistence errors or retry them", async () => {
  const transactionFailure = Object.assign(new Error("Transient transaction failure"), {
    errorLabels: ["TransientTransactionError"],
    hasErrorLabel(label) {
      return this.errorLabels.includes(label);
    },
  });
  persistHistoryEvent.mockRejectedValue(transactionFailure);

  const result = await batch([envelope(20)]);

  expect(result.failed).toBe(1);
  expect(result.results[0].error).toBe(transactionFailure);
  expect(persistHistoryEvent).toHaveBeenCalledTimes(1);
});

test("marks an unexpected persistence response as a per-item failure", async () => {
  persistHistoryEvent.mockResolvedValue({ status: "failed" });

  const result = await batch([envelope(21)]);

  expect(result.failed).toBe(1);
  expect(result.results[0].error).toBeInstanceOf(Error);
  expect(result.results[0].error.message)
    .toBe("History persistence returned an invalid result.");
});
