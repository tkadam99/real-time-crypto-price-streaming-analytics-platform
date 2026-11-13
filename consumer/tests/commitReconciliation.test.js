const { Long } = require("mongodb");
const { createCommitReconciliation, inspectEligible } = require("../src/commitReconciliation");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function mockCollection(documents = []) {
  const cursor = {
    hint: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    toArray: jest.fn().mockResolvedValue(documents),
  };
  return { find: jest.fn().mockReturnValue(cursor), cursor };
}

function document(partition, offset, overrides = {}) {
  return {
    _id: JSON.stringify(["prices", partition, offset]),
    groupId: "group", topic: "prices", partition, offset: Long.fromString(offset),
    ...overrides,
  };
}

describe("commit reconciliation", () => {
  let admin;
  let collection;
  let worker;
  let log;
  let error;

  beforeEach(() => {
    jest.useFakeTimers();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    error = jest.spyOn(console, "error").mockImplementation(() => {});
    admin = {
      connect: jest.fn().mockResolvedValue(),
      disconnect: jest.fn().mockResolvedValue(),
      fetchOffsets: jest.fn().mockResolvedValue([{ topic: "prices", partitions: [] }]),
    };
    collection = mockCollection();
    worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices" });
  });

  afterEach(async () => {
    await worker.drain();
    jest.useRealTimers();
    log.mockRestore();
    error.mockRestore();
  });

  async function flush() {
    await jest.advanceTimersByTimeAsync(0);
  }

  function report() {
    return JSON.parse(log.mock.calls[log.mock.calls.length - 1][1]);
  }

  it("uses only read-only fetch offsets and queries valid independent partitions", async () => {
    const offset = "9007199254740994";
    admin.fetchOffsets.mockResolvedValue([{ topic: "prices", partitions: [
      { partition: 0, offset }, { partition: 1, offset: "3" },
      { partition: 2, offset: "-1" }, { partition: 3, offset: "bad" },
    ] }]);
    worker.start();
    expect(admin.connect).not.toHaveBeenCalled();
    await flush();
    expect(admin.fetchOffsets).toHaveBeenCalledWith({
      groupId: "group", topics: ["prices"], resolveOffsets: false,
    });

    expect(collection.find).toHaveBeenCalledTimes(2);
    expect(collection.find.mock.calls[0][0]).toEqual({
      groupId: "group", topic: "prices", partition: 0,
      offset: { $type: "long", $gte: Long.ZERO, $lt: Long.fromString(offset) },
    });
    expect(collection.cursor.hint).toHaveBeenCalledWith("decision_group_topic_partition_offset");
    expect(collection.cursor.limit).toHaveBeenCalledWith(100);
    expect(report().partitions).toEqual([
      expect.objectContaining({ partition: 0, state: "verified", committedNextOffset: offset }),
      expect.objectContaining({ partition: 1, state: "verified", committedNextOffset: "3" }),
      expect.objectContaining({ partition: 2, state: "missing-or-uncertain", eligibleSampleCount: null }),
      expect.objectContaining({ partition: 3, state: "missing-or-uncertain", eligibleSampleCount: null }),
    ]);
  });

  it("only signals work synchronously from a commit notification", async () => {
    admin.fetchOffsets.mockResolvedValue([{ topic: "prices", partitions: [{ partition: 0, offset: "1" }] }]);
    worker.start();
    await flush();
    admin.fetchOffsets.mockClear();
    worker.schedule("commit");
    expect(admin.fetchOffsets).not.toHaveBeenCalled();
    await flush();
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(1);
  });

  it("rejects uncertain and conflicting broker responses without using stale offsets", async () => {
    admin.fetchOffsets
      .mockResolvedValueOnce([{ topic: "prices", partitions: [{ partition: 0, offset: "20" }] }])
      .mockResolvedValueOnce([{ topic: "prices", partitions: [{ partition: 0, offset: "10" }] }])
      .mockResolvedValueOnce([{ topic: "prices", partitions: [{ partition: 0, offset: "-1" }] }])
      .mockResolvedValueOnce([{ topic: "other", partitions: [{ partition: 0, offset: "20" }] }]);
    worker.start();
    await flush();
    worker.schedule("commit");
    await flush();
    expect(report().partitions[0]).toMatchObject({ state: "decreased", committedNextOffset: "10" });
    worker.schedule("commit");
    await flush();
    expect(report().partitions[0]).toMatchObject({ state: "missing-or-uncertain", eligibleSampleCount: null });
    worker.schedule("commit");
    await flush();
    expect(error).toHaveBeenCalledWith("Commit reconciliation failed:", expect.stringContaining("Uncertain"));
    expect(collection.find).toHaveBeenCalledTimes(2);
  });

  it.each([
    null, undefined, -1, 9007199254740994, "", "01", "-2", "9223372036854775808",
  ])("does not inspect an invalid or absent committed offset %s", async (offset) => {
    admin.fetchOffsets.mockResolvedValue([{ topic: "prices", partitions: [{ partition: 0, offset }] }]);
    worker.start();
    await flush();
    expect(collection.find).not.toHaveBeenCalled();
    expect(report().partitions[0]).toMatchObject({
      partition: 0, state: "missing-or-uncertain", eligibleSampleCount: null,
    });
  });

  it("fails closed on duplicate or invalid partitions", async () => {
    admin.fetchOffsets.mockResolvedValue([{ topic: "prices", partitions: [
      { partition: 0, offset: "1" }, { partition: 0, offset: "2" },
    ] }]);
    worker.start();
    await flush();
    expect(collection.find).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "Commit reconciliation failed:", expect.stringContaining("duplicate Kafka partition")
    );
  });

  it("coalesces repeated triggers without overlapping cycles and supports periodic reconciliation", async () => {
    const pending = deferred();
    admin.fetchOffsets.mockReturnValueOnce(pending.promise).mockResolvedValue([
      { topic: "prices", partitions: [{ partition: 0, offset: "1" }] },
    ]);
    worker.start();
    await flush();
    worker.schedule("commit");
    worker.schedule("commit");
    worker.schedule("group-join");
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(1);
    pending.resolve([{ topic: "prices", partitions: [{ partition: 0, offset: "1" }] }]);
    await flush();
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(2);
    expect(report().triggers).toEqual(["commit", "group-join"]);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(3);
    expect(report().triggers).toEqual(["periodic"]);
  });

  it("reports fetch and inspection failures and retries on a later trigger", async () => {
    admin.fetchOffsets.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue([
      { topic: "prices", partitions: [{ partition: 0, offset: "4" }] },
    ]);
    collection.cursor.toArray.mockRejectedValueOnce(new Error("read failed")).mockResolvedValue([]);
    worker.start();
    await flush();
    expect(error).toHaveBeenCalledWith("Commit reconciliation failed:", expect.stringContaining("fetch failed"));
    worker.schedule("commit");
    await flush();
    expect(report()).toMatchObject({
      retry: "next trigger or periodic cycle",
      partitions: [{ partition: 0, state: "inspection-failed", committedNextOffset: "4", eligibleSampleCount: null, error: "read failed" }],
    });
    worker.schedule("commit");
    await flush();
    expect(report().partitions[0].state).toBe("verified");
  });

  it("stops scheduling and drains in-flight work before disconnecting", async () => {
    const pending = deferred();
    admin.fetchOffsets.mockReturnValue(pending.promise);
    worker.start();
    await flush();
    worker.stopScheduling();
    worker.schedule("commit");
    const draining = worker.drain();
    expect(admin.disconnect).not.toHaveBeenCalled();
    pending.resolve([{ topic: "prices", partitions: [{ partition: 0, offset: "1" }] }]);
    await draining;
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(1);
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });
});

it("filters conflicting, missing, malformed and at-boundary sampled metadata", async () => {
  const collection = mockCollection([
    document(0, "4"),
    document(0, "5"),
    document(0, "3", { groupId: "other" }),
    document(0, "3", { topic: "other" }),
    document(1, "3"),
    document(0, "3", { _id: "legacy" }),
    document(0, "3", { offset: 3 }),
    { _id: "legacy" },
  ]);
  expect(await inspectEligible(collection, "group", "prices", 0, "5"))
    .toEqual({ eligibleSampleCount: 1, inspectedSampleCount: 8 });
});
