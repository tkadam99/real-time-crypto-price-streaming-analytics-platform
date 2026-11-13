const {
  eventTime, kafkaTime, describeMessage, offset, snapshots, progress, sampleRanges, sampleTail,
} = require("../scripts/kafkaTailDiagnostic");

const now = Date.parse("2026-01-01T00:01:00Z");
const topic = "test-topic";

function fakeConsumer() {
  const consumer = {
    events: { CRASH: "crash" },
    on: jest.fn(() => jest.fn()),
    subscribe: jest.fn().mockResolvedValue(),
    run: jest.fn().mockResolvedValue(),
    seek: jest.fn(),
    pause: jest.fn(),
  };
  return consumer;
}

function snapshot(partition, low, end, committed = "0") {
  return { partition, low, end, committed, lag: (BigInt(end) - BigInt(committed)).toString() };
}

async function startSample(consumer, entries, signal = new AbortController().signal) {
  const promise = sampleTail(consumer, topic, entries, signal);
  await Promise.resolve();
  await Promise.resolve();
  return { promise, batch: consumer.run.mock.calls[0][0].eachBatch };
}

function message(value, position = "0", timestamp = String(now)) {
  return { value: value === null ? null : Buffer.from(value), offset: position, timestamp };
}

describe("market timestamps and Kafka offsets", () => {
  test("validates ISO market time and identifies future skew", () => {
    expect(eventTime("2026-01-01T00:00:00.123456Z", now)).toEqual({
      status: "valid", timestamp: "2026-01-01T00:00:00.123456Z", ageMs: 59877,
    });
    expect(eventTime("2026-01-01T01:01:01+01:00", now).status).toBe("future");
    for (const value of [undefined, "", 42, "not a date", "2026-02-29T00:00:00Z", "2026-01-01", "2026-01-01T25:00:00Z"]) {
      expect(eventTime(value, now).status).toBe("missing-or-invalid");
    }
    expect(eventTime("2024-02-29T00:00:00Z", now).status).toBe("valid");
  });

  test("reports Kafka timestamp separately and handles malformed payloads", () => {
    const result = describeMessage(message('{"timestamp":"2026-01-01T00:00:00Z"}'), now);
    expect(result.marketTime.ageMs).toBe(60000);
    expect(result.kafkaTime.ageMs).toBe(0);
    expect(kafkaTime("-1", now).status).toBe("missing-or-invalid");
    expect(kafkaTime("9999999999999999999", now).status).toBe("missing-or-invalid");
    for (const value of [null, "{", "null", "[]", "123"]) {
      expect(describeMessage(message(value), now).payload).toBe("malformed");
    }
    expect(describeMessage(message("{}"), now).marketTime.status).toBe("missing-or-invalid");
  });

  test("uses exact integer arithmetic and preserves missing commits and negative lag", () => {
    const before = snapshots([
      { partition: 0, low: "10", high: "9007199254741002" },
      { partition: 1, low: "0", high: "20" },
      { partition: 2, low: "0", high: "4" },
    ], [{ topic, partitions: [{ partition: 0, offset: "9007199254740993" }, { partition: 1, offset: "-1" }, { partition: 2, offset: "5" }] }], topic);
    expect(before.map((item) => item.lag)).toEqual(["9", null, "-1"]);
    expect(before.map((item) => item.commitStatus)).toEqual(["valid", "missing", "valid"]);
    expect(snapshots([{ partition: 0, low: "0", high: "2" }], [{ topic, partitions: [{ partition: 0, offset: "bad" }] }], topic)[0].commitStatus).toBe("invalid");
    expect(offset("1.2")).toBeNull();
    const after = snapshots([
      { partition: 0, low: "10", high: "9007199254741012" },
      { partition: 1, low: "0", high: "25" },
    ], [{ topic, partitions: [{ partition: 0, offset: "9007199254741000" }] }], topic);
    expect(progress(before, after, 5000)).toEqual([
      { partition: 0, endAdvancement: "10", endOffsetsPerSecond: "2.00", committedAdvancement: "7", committedOffsetsPerSecond: "1.40", lagChange: "3" },
      { partition: 1, endAdvancement: "5", endOffsetsPerSecond: "1.00", committedAdvancement: null, committedOffsetsPerSecond: null, lagChange: null },
      { partition: 2, status: "missing-partition" },
    ]);
  });
});

describe("bounded isolated tail sampling", () => {
  test("limits each range to five offsets and handles empty partitions", () => {
    const ranges = sampleRanges([snapshot(0, "0", "100"), snapshot(1, "7", "9"), snapshot(2, "0", "0")]);
    expect(ranges.map(({ start, end, done }) => [start, end, done])).toEqual([
      [95n, 100n, false], [7n, 9n, false], [0n, 0n, true],
    ]);
  });

  test("seeks only the temporary consumer and stops at the captured end", async () => {
    const consumer = fakeConsumer();
    const { promise, batch } = await startSample(consumer, [snapshot(0, "0", "10")]);
    expect(consumer.run.mock.calls[0][0]).toMatchObject({ autoCommit: false, eachBatchAutoResolve: false });
    expect(consumer.seek).toHaveBeenCalledWith({ topic, partition: 0, offset: "5" });
    const resolveOffset = jest.fn();
    await batch({
      batch: { partition: 0, messages: [4, 5, 6, 7, 8, 9, 10].map((n) => message("{}", String(n))) },
      resolveOffset, isStale: () => false,
    });
    const result = await promise;
    expect(result.ranges[0].samples.map((item) => item.offset)).toEqual(["5", "6", "7", "8", "9"]);
    expect(consumer.pause).toHaveBeenCalledWith([{ topic, partitions: [0] }]);
    expect(result.timedOut).toBe(false);
  });

  test("times out with partial results if offsets are missing or compacted", async () => {
    jest.useFakeTimers();
    try {
      const consumer = fakeConsumer();
      const { promise, batch } = await startSample(consumer, [snapshot(0, "0", "10")]);
      await batch({
        batch: { partition: 0, messages: [message("{}", "7")] },
        resolveOffset: jest.fn(), isStale: () => false,
      });
      await jest.advanceTimersByTimeAsync(15000);
      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.ranges[0].done).toBe(false);
      expect(result.ranges[0].samples).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("ignores stale batches and aborts promptly", async () => {
    const consumer = fakeConsumer();
    const abort = new AbortController();
    const { promise, batch } = await startSample(consumer, [snapshot(0, "0", "10")], abort.signal);
    await batch({ batch: { partition: 0, messages: [message("{}", "9")] }, resolveOffset: jest.fn(), isStale: () => true });
    abort.abort();
    const result = await promise;
    expect(result.aborted).toBe(true);
    expect(result.ranges[0].samples).toHaveLength(0);
  });

  test("samples partitions independently and never emits offsets at or beyond their captured ends", async () => {
    const consumer = fakeConsumer();
    const { promise, batch } = await startSample(consumer, [snapshot(0, "0", "2"), snapshot(1, "0", "1")]);
    const send = async (partition, positions) => batch({
      batch: { partition, messages: positions.map((position) => message("{}", String(position))) },
      resolveOffset: jest.fn(), isStale: () => false,
    });
    await send(1, [0, 1, 2]);
    await send(0, [0, 1, 2]);
    const result = await promise;
    expect(result.ranges.map((range) => range.samples.map((item) => item.offset))).toEqual([["0", "1"], ["0"]]);
    expect(consumer.seek).toHaveBeenCalledTimes(2);
  });

  test("reports a consumer crash instead of waiting for the sampling timeout", async () => {
    const consumer = fakeConsumer();
    const { promise } = await startSample(consumer, [snapshot(0, "0", "1")]);
    consumer.on.mock.calls[0][1]();
    await expect(promise).rejects.toThrow("Diagnostic consumer crashed");
  });

  test("bounds partition count and rejects invalid topic offsets", () => {
    expect(() => snapshots(Array.from({ length: 33 }, (_, partition) => ({ partition, low: "0", high: "1" })), [], topic)).toThrow();
    expect(() => snapshots([{ partition: 0, low: "5", high: "4" }], [], topic)).toThrow();
  });
});
