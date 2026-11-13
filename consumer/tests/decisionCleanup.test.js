const { Long } = require("mongodb");
const { createCommitReconciliation } = require("../src/commitReconciliation");

function decision(partition, offset, extra = {}) {
  return {
    _id: JSON.stringify(["prices", partition, offset]), groupId: "group", topic: "prices",
    partition, offset: Long.fromString(offset), alertCandidate: null,
    previousPrice: null, percentChange: 0, ...extra,
  };
}

function response(entries = [{ partition: 0, offset: "3" }]) {
  return [{ topic: "prices", partitions: entries }];
}

describe("bounded decision cleanup", () => {
  let admin;
  let collection;
  let worker;
  let log;
  let error;
  let candidates;

  beforeEach(() => {
    jest.useFakeTimers();
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    error = jest.spyOn(console, "error").mockImplementation(() => {});
    admin = {
      connect: jest.fn().mockResolvedValue(),
      disconnect: jest.fn().mockResolvedValue(),
      fetchOffsets: jest.fn().mockResolvedValue(response()),
    };
    candidates = [decision(0, "0"), decision(0, "1")];
    collection = {
      find: jest.fn((_filter, options) => {
        const cursor = {
          hint: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          toArray: jest.fn(async () => options.projection ? [] : candidates),
        };
        return cursor;
      }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 2 }),
    };
  });

  afterEach(async () => {
    if (worker) await worker.drain();
    worker = undefined;
    jest.useRealTimers();
    log.mockRestore();
    error.mockRestore();
  });

  async function start(enabled = true) {
    worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices", cleanupEnabled: enabled });
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
  }

  function report() {
    return JSON.parse(log.mock.calls[log.mock.calls.length - 1][1]);
  }

  function selectionPages(pages) {
    collection.find = jest.fn((_filter, options) => {
      const cursor = {
        hint: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        toArray: jest.fn(async () => {
          if (options.projection) return [];
          const page = pages.shift() || [];
          if (page instanceof Error) throw page;
          return page;
        }),
      };
      return cursor;
    });
  }

  it("is read-only by default and rejects invalid flags or scope", async () => {
    worker = createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices" });
    worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(collection.deleteMany).not.toHaveBeenCalled();
    expect(report().cleanup.enabled).toBe(false);
    expect(() => createCommitReconciliation({ admin, collection, groupId: "", topic: "prices", cleanupEnabled: true }))
      .toThrow("requires a configured consumer group and topic");
    expect(() => createCommitReconciliation({ admin, collection, groupId: "group", topic: "prices", cleanupEnabled: "true" }))
      .toThrow("Invalid decision cleanup setting");
  });

  it("rechecks the broker and repeats scope, exact offsets and decision snapshots in the delete", async () => {
    candidates.push(decision(0, "3"), decision(0, "4"), decision(0, "2", { groupId: "other" }));
    await start();
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(2);
    const [filter, options] = collection.deleteMany.mock.calls[0];
    expect(filter).toMatchObject({
      groupId: "group", topic: "prices", partition: 0,
      offset: { $type: "long", $gte: Long.ZERO, $lt: Long.fromString("3") },
      $or: [{ _id: candidates[0]._id, offset: Long.ZERO }, { _id: candidates[1]._id, offset: Long.ONE }],
    });
    expect(options).toEqual({ hint: "decision_group_topic_partition_offset" });
    expect(report().cleanup).toMatchObject({ enabled: true, batchesAttempted: 1, deleted: 2 });
  });

  it.each(["2", "-1", "invalid", null])("does not delete after a decreased or missing revalidation %s", async (offset) => {
    admin.fetchOffsets.mockResolvedValueOnce(response()).mockResolvedValueOnce(response([{ partition: 0, offset }]));
    await start();
    expect(collection.deleteMany).not.toHaveBeenCalled();
    expect(report().cleanup.partitions[0].state).toBe("boundary-changed-or-missing");
  });

  it.each(["-1", "bad", null])("does not select or delete on an uncertain initial offset %s", async (offset) => {
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset }]));
    await start();
    expect(collection.find).not.toHaveBeenCalled();
    expect(collection.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed if the partition disappears or a revalidation response is malformed", async () => {
    admin.fetchOffsets.mockResolvedValueOnce(response()).mockResolvedValueOnce(response([{ partition: 1, offset: "3" }]));
    await start();
    expect(collection.deleteMany).not.toHaveBeenCalled();
    expect(report().cleanup.partitions[0].state).toBe("boundary-changed-or-missing");
    admin.fetchOffsets.mockResolvedValueOnce(response()).mockResolvedValueOnce(response([
      { partition: 0, offset: "3" }, { partition: 0, offset: "3" },
    ]));
    worker.schedule("commit");
    await jest.advanceTimersByTimeAsync(0);
    expect(collection.deleteMany).not.toHaveBeenCalled();
    expect(report().cleanup.partitions[0].state).toBe("failed");
  });

  it("does not delete on a decreased cycle boundary, even for repeated commit triggers", async () => {
    admin.fetchOffsets.mockResolvedValueOnce(response([{ partition: 0, offset: "5" }]))
      .mockResolvedValueOnce(response([{ partition: 0, offset: "5" }]))
      .mockResolvedValueOnce(response([{ partition: 0, offset: "2" }]));
    await start();
    expect(collection.deleteMany).toHaveBeenCalledTimes(1);
    worker.schedule("commit");
    worker.schedule("commit");
    await jest.advanceTimersByTimeAsync(0);
    expect(report().partitions[0]).toMatchObject({ state: "decreased", committedNextOffset: "2" });
    expect(collection.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("uses exact large offset strings and partitions independently", async () => {
    const high = "9007199254740994";
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset: high }, { partition: 1, offset: "-1" }]));
    candidates = [decision(0, "9007199254740993"), decision(1, "0")];
    collection.deleteMany.mockResolvedValue({ deletedCount: 1 });
    await start();
    const filter = collection.deleteMany.mock.calls[0][0];
    expect(filter.offset.$lt.toString()).toBe(high);
    expect(filter.$or).toHaveLength(1);
    expect(filter.$or[0]._id).toBe(candidates[0]._id);
    expect(report().partitions[1].state).toBe("missing-or-uncertain");
  });

  it("never deletes metadata-free, malformed or invalid decisions", async () => {
    candidates = [
      { _id: "legacy" },
      decision(0, "0", { offset: 0 }),
      decision(0, "1", { groupId: ["group"] }),
      decision(0, "2", { _id: "wrong" }),
      decision(0, "0", { alertCandidate: { invalid: true } }),
    ];
    await start();
    expect(collection.deleteMany).not.toHaveBeenCalled();
    expect(report().cleanup.partitions[0]).toMatchObject({ state: "ambiguous-records", ambiguous: 5 });
  });

  it("reports partial deletion and retries on a later trigger", async () => {
    collection.deleteMany.mockResolvedValueOnce({ deletedCount: 1 }).mockResolvedValueOnce({ deletedCount: 2 });
    await start();
    expect(report().cleanup.partitions[0]).toMatchObject({ state: "partial", deleted: 1 });
    worker.schedule("commit");
    await jest.advanceTimersByTimeAsync(0);
    expect(report().cleanup.deleted).toBe(2);
  });

  it.each(["read", "delete", "fetch"])("reports a %s failure and retries", async (failure) => {
    if (failure === "read") {
      const original = collection.find;
      collection.find = jest.fn((filter, options) => {
        const cursor = original(filter, options);
        if (!options.projection) cursor.toArray.mockRejectedValueOnce(new Error("read failed"));
        return cursor;
      });
    } else if (failure === "delete") {
      collection.deleteMany.mockRejectedValueOnce(new Error("delete failed"));
    } else {
      admin.fetchOffsets.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("fetch failed"));
    }
    await start();
    expect(report().cleanup.partitions[0]).toMatchObject({ state: "failed", error: `${failure} failed` });
    if (failure === "delete") expect(report().cleanup.deletionCountUncertain).toBe(true);
    expect(error).toHaveBeenCalled();
    if (failure === "read") {
      collection.find = jest.fn((_filter, options) => {
        const cursor = {
          hint: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
          toArray: jest.fn().mockResolvedValue(options.projection ? [] : candidates),
        };
        return cursor;
      });
    }
    worker.schedule("retry");
    await jest.advanceTimersByTimeAsync(0);
    expect(report().cleanup.deleted).toBe(2);
  });

  it("limits each cycle and rotates across partitions", async () => {
    const entries = Array.from({ length: 6 }, (_, partition) => ({ partition, offset: "3" }));
    admin.fetchOffsets.mockResolvedValue(response(entries));
    candidates = [];
    await start();
    expect(report().cleanup.partitions).toHaveLength(4);
    expect(report().cleanup.workLimitReached).toBe(true);
    await jest.advanceTimersByTimeAsync(50);
    expect(report().cleanup.partitions.map((p) => p.partition)).toEqual([4, 5, 0, 1]);
    await jest.advanceTimersByTimeAsync(50);
    expect(report().cleanup.followUpScheduled).toBe(false);
  });

  it("automatically gives partitions beyond the per-cycle limit a turn", async () => {
    const remaining = new Set([0, 1, 2, 3, 4, 5]);
    admin.fetchOffsets.mockResolvedValue(response(
      Array.from(remaining, (partition) => ({ partition, offset: "3" }))
    ));
    collection.find = jest.fn((filter, options) => {
      const cursor = {
        hint: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
        toArray: jest.fn(async () => options.projection || !remaining.has(filter.partition)
          ? [] : [decision(filter.partition, "0")]),
      };
      return cursor;
    });
    collection.deleteMany.mockImplementation(async (filter) => {
      remaining.delete(filter.partition);
      return { deletedCount: 1 };
    });
    await start();
    expect([...remaining]).toEqual([4, 5]);
    await jest.advanceTimersByTimeAsync(50);
    expect(remaining.size).toBe(0);
    expect(collection.deleteMany.mock.calls.map(([filter]) => filter.partition)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("retries cleanup on the periodic reconciliation", async () => {
    collection.deleteMany.mockRejectedValueOnce(new Error("delete failed"))
      .mockResolvedValueOnce({ deletedCount: 2 });
    await start();
    expect(report().cleanup.deletionCountUncertain).toBe(true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(report().triggers).toEqual(["periodic"]);
    expect(report().cleanup.deleted).toBe(2);
  });

  it("automatically continues a full batch after yielding and stops after the final page", async () => {
    const page = Array.from({ length: 500 }, (_, value) => decision(0, String(value)));
    selectionPages([page, [decision(0, "500")]]);
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset: "600" }]));
    collection.deleteMany.mockResolvedValueOnce({ deletedCount: 500 }).mockResolvedValueOnce({ deletedCount: 1 });
    await start();
    expect(report().cleanup).toMatchObject({ workLimitReached: true, followUpScheduled: true });
    const count = admin.fetchOffsets.mock.calls.length;
    await jest.advanceTimersByTimeAsync(49);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(count);
    await jest.advanceTimersByTimeAsync(1);
    expect(report().triggers).toEqual(["catch-up"]);
    expect(report().cleanup).toMatchObject({ deleted: 1, followUpScheduled: false });
    expect(collection.deleteMany).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1000);
    expect(collection.deleteMany).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated triggers and never overlaps a follow-up with an in-flight batch", async () => {
    const page = Array.from({ length: 500 }, (_, value) => decision(0, String(value)));
    selectionPages([page, []]);
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset: "600" }]));
    let finish;
    collection.deleteMany.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await start();
    worker.schedule("commit");
    worker.schedule("commit");
    worker.schedule("group-join");
    await jest.advanceTimersByTimeAsync(100);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(2);
    finish({ deletedCount: 500 });
    await jest.advanceTimersByTimeAsync(0);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(50);
    expect(report().triggers).toEqual(["commit", "group-join", "catch-up"]);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(3);
  });

  it("stops automatic scanning of full ambiguous pages without deleting them", async () => {
    const page = Array.from({ length: 500 }, (_, value) =>
      decision(0, String(value), { _id: `invalid-${value}` }));
    selectionPages([...Array(8).fill(page), [decision(0, "500")]]);
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset: "600" }]));
    await start();
    await jest.advanceTimersByTimeAsync(500);
    expect(log).toHaveBeenCalledTimes(8);
    expect(collection.deleteMany).not.toHaveBeenCalled();
    expect(report().cleanup.followUpScheduled).toBe(false);
    const calls = admin.fetchOffsets.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(calls);
    collection.deleteMany.mockResolvedValue({ deletedCount: 1 });
    worker.schedule("periodic");
    await jest.advanceTimersByTimeAsync(0);
    expect(collection.deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each(["2", "-1"])("stops automatic catch-up when the next cycle observes offset %s", async (offset) => {
    const page = Array.from({ length: 500 }, (_, value) => decision(0, String(value)));
    selectionPages([page]);
    admin.fetchOffsets.mockResolvedValueOnce(response([{ partition: 0, offset: "600" }]))
      .mockResolvedValueOnce(response([{ partition: 0, offset: "600" }]))
      .mockResolvedValue(response([{ partition: 0, offset }]));
    collection.deleteMany.mockResolvedValue({ deletedCount: 500 });
    await start();
    await jest.advanceTimersByTimeAsync(50);
    expect(collection.deleteMany).toHaveBeenCalledTimes(1);
    expect(report().partitions[0].state).toBe(offset === "-1" ? "missing-or-uncertain" : "decreased");
    await jest.advanceTimersByTimeAsync(1000);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(3);
  });

  it.each(["599", "-1"])("blocks the follow-up batch when its revalidated offset is %s", async (offset) => {
    const page = Array.from({ length: 500 }, (_, value) => decision(0, String(value)));
    selectionPages([page, [decision(0, "500")]]);
    admin.fetchOffsets.mockResolvedValueOnce(response([{ partition: 0, offset: "600" }]))
      .mockResolvedValueOnce(response([{ partition: 0, offset: "600" }]))
      .mockResolvedValueOnce(response([{ partition: 0, offset: "600" }]))
      .mockResolvedValueOnce(response([{ partition: 0, offset }]));
    collection.deleteMany.mockResolvedValue({ deletedCount: 500 });
    await start();
    await jest.advanceTimersByTimeAsync(50);
    expect(collection.deleteMany).toHaveBeenCalledTimes(1);
    expect(report().cleanup.partitions[0].state).toBe("boundary-changed-or-missing");
    expect(report().cleanup.followUpScheduled).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(4);
  });

  it("does not automatically retry a partial deletion of a full page", async () => {
    const page = Array.from({ length: 500 }, (_, value) => decision(0, String(value)));
    selectionPages([page]);
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset: "600" }]));
    collection.deleteMany.mockResolvedValue({ deletedCount: 499 });
    await start();
    expect(report().cleanup.partitions[0].state).toBe("partial");
    expect(report().cleanup.followUpScheduled).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    expect(collection.deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each(["fetch", "read", "delete"])("defers a %s failure during catch-up without a retry storm", async (failure) => {
    const page = Array.from({ length: 500 }, (_, value) => decision(0, String(value)));
    const nextPage = [decision(0, "500")];
    selectionPages([page, failure === "read" ? new Error("read failed") : nextPage]);
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset: "600" }]));
    if (failure === "fetch") {
      admin.fetchOffsets.mockResolvedValueOnce(response([{ partition: 0, offset: "600" }]))
        .mockResolvedValueOnce(response([{ partition: 0, offset: "600" }]))
        .mockRejectedValueOnce(new Error("fetch failed"));
    }
    collection.deleteMany.mockResolvedValueOnce({ deletedCount: 500 });
    if (failure === "delete") collection.deleteMany.mockRejectedValueOnce(new Error("delete failed"));
    else collection.deleteMany.mockResolvedValue({ deletedCount: 1 });
    await start();
    await jest.advanceTimersByTimeAsync(50);
    expect(error).toHaveBeenCalled();
    const fetches = admin.fetchOffsets.mock.calls.length;
    await jest.advanceTimersByTimeAsync(1000);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(fetches);
  });

  it("cancels a scheduled follow-up and queued triggers at shutdown", async () => {
    const page = Array.from({ length: 500 }, (_, value) => decision(0, String(value)));
    selectionPages([page]);
    admin.fetchOffsets.mockResolvedValue(response([{ partition: 0, offset: "600" }]));
    collection.deleteMany.mockResolvedValue({ deletedCount: 500 });
    await start();
    worker.schedule("commit");
    await worker.drain();
    await jest.advanceTimersByTimeAsync(1000);
    expect(admin.fetchOffsets).toHaveBeenCalledTimes(2);
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
  });

  it("coalesces triggers and drains an in-flight deletion", async () => {
    let finish;
    collection.deleteMany.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await start();
    worker.schedule("commit");
    worker.schedule("commit");
    const draining = worker.drain();
    expect(admin.disconnect).not.toHaveBeenCalled();
    finish({ deletedCount: 2 });
    await draining;
    expect(admin.disconnect).toHaveBeenCalledTimes(1);
    expect(collection.deleteMany).toHaveBeenCalledTimes(1);
  });

  it("coalesces commit triggers while a delete is in flight", async () => {
    let finish;
    collection.deleteMany.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValue({ deletedCount: 2 });
    await start();
    worker.schedule("commit");
    worker.schedule("commit");
    worker.schedule("group-join");
    finish({ deletedCount: 2 });
    await jest.advanceTimersByTimeAsync(0);
    expect(collection.deleteMany).toHaveBeenCalledTimes(2);
    expect(report().triggers).toEqual(["commit", "group-join"]);
  });
});
