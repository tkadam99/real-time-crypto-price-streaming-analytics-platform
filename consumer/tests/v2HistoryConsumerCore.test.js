const {
  serializeSourceIdentity,
  createEnvelope,
} = require("../v2/eventContract");
const {
  MAX_MESSAGES_PER_PERSISTENCE_CALL,
  V2_TOPIC,
  processHistoryPartitionBatch,
} = require("../v2/historyConsumerCore");

const source = {
  clusterId: "source-cluster",
  topicGenerationId: "source-topic-generation",
  topic: "crypto-prices",
  partition: 0,
  offset: "9007199254740993",
};

function envelope(symbol = "BTC-USD", sourceOffset = source.offset) {
  return createEnvelope({
    symbol,
    price: 105.5,
    timestamp: "2026-01-01T00:01:00+00:00",
  }, { ...source, offset: sourceOffset });
}

function message(offset, event = envelope()) {
  return { offset: String(offset), value: Buffer.from(JSON.stringify(event)) };
}

function persistenceResult(envelopes, statuses = []) {
  return {
    results: envelopes.map((item, index) => ({
      index,
      status: statuses[index] || "inserted",
      eventIdentity: serializeSourceIdentity(item.source),
    })),
  };
}

describe("offline V2 history consumer processing core", () => {
  test("returns an empty committable prefix without invoking persistence", async () => {
    const persistBatch = jest.fn();

    await expect(processHistoryPartitionBatch({
      partition: 0,
      messages: [],
      persistBatch,
    })).resolves.toEqual({
      topic: V2_TOPIC,
      partition: 0,
      committablePrefix: [],
      committableCount: 0,
      nextOffset: null,
      persistedAfterFailure: [],
      failure: null,
    });
    expect(persistBatch).not.toHaveBeenCalled();
  });

  test("validates and routes BTC, ETH, and SOL only to their assigned partitions", async () => {
    for (const [symbol, partition] of [
      ["BTC-USD", 0],
      ["ETH-USD", 1],
      ["SOL-USD", 2],
    ]) {
      const event = envelope(symbol);
      const persistBatch = jest.fn(async (events) => persistenceResult(events, ["replay"]));
      const result = await processHistoryPartitionBatch({
        partition,
        messages: [message("15", event)],
        persistBatch,
      });

      expect(result.failure).toBeNull();
      expect(result.committablePrefix).toEqual([{ offset: "15", status: "replay" }]);
      expect(result.nextOffset).toBe("16");
      expect(persistBatch).toHaveBeenCalledWith([event]);
      expect(persistBatch.mock.calls[0][0][0]).toEqual(event);
    }
  });

  test("uses Kafka offsets for commits and preserves the exact V1 source identity", async () => {
    const event = envelope("ETH-USD", "9223372036854775807");
    const persistBatch = jest.fn(async (events) => persistenceResult(events, ["inserted", "replay"]));
    const result = await processHistoryPartitionBatch({
      partition: 1,
      messages: [message("9007199254740993", event), message("9007199254740994", event)],
      persistBatch,
    });

    expect(result.nextOffset).toBe("9007199254740995");
    expect(result.committablePrefix.map((item) => item.offset)).toEqual([
      "9007199254740993",
      "9007199254740994",
    ]);
    expect(persistBatch.mock.calls[0][0][0].source.offset).toBe("9223372036854775807");
    expect(serializeSourceIdentity(persistBatch.mock.calls[0][0][0].source))
      .toBe(serializeSourceIdentity(event.source));
  });

  test("processes arbitrary message counts in bounded persistence calls", async () => {
    const messages = Array.from({ length: 205 }, (_, index) =>
      message(String(index), envelope("BTC-USD", String(index))));
    const persistBatch = jest.fn(async (events) => persistenceResult(events));

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages,
      persistBatch,
    });

    expect(persistBatch.mock.calls.map(([events]) => events.length)).toEqual([100, 100, 5]);
    expect(persistBatch.mock.calls.every(([events]) =>
      events.length <= MAX_MESSAGES_PER_PERSISTENCE_CALL,
    )).toBe(true);
    expect(result.committableCount).toBe(205);
    expect(result.nextOffset).toBe("205");
  });

  test("cancellation before processing begins starts no persistence batch", async () => {
    const controller = new AbortController();
    controller.abort();
    const persistBatch = jest.fn();

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: [message("1"), message("2")],
      persistBatch,
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      cancelled: true,
      committablePrefix: [],
      committableCount: 0,
      nextOffset: null,
      failure: null,
    });
    expect(persistBatch).not.toHaveBeenCalled();
  });

  test("cancellation between persistence chunks prevents the next chunk from starting", async () => {
    const controller = new AbortController();
    const messages = Array.from({ length: 101 }, (_, index) =>
      message(String(index), envelope("BTC-USD", String(index))));
    const persistBatch = jest.fn(async (events) => {
      const result = persistenceResult(events);
      controller.abort();
      return result;
    });

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages,
      persistBatch,
      signal: controller.signal,
    });

    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch.mock.calls[0][0]).toHaveLength(100);
    expect(result).toMatchObject({
      cancelled: true,
      committableCount: 100,
      nextOffset: "100",
      failure: null,
    });
  });

  test.each([
    ["malformed JSON", "{PRIVATE-PAYLOAD-SENTINEL", "malformed-json", "PRIVATE-PAYLOAD-SENTINEL"],
    [
      "invalid envelope",
      JSON.stringify({ ...envelope(), source: { ...source, offset: "01" }, secret: "PRIVATE-PAYLOAD-SENTINEL" }),
      "invalid-envelope",
      "PRIVATE-PAYLOAD-SENTINEL",
    ],
  ])("stops at the first %s without sending later messages to persistence", async (
    _label,
    invalidValue,
    classification,
    payloadMarker,
  ) => {
    const preceding = envelope();
    const persistBatch = jest.fn(async (events) => persistenceResult(events));
    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: [
        message("4", preceding),
        { offset: "5", value: Buffer.from(invalidValue) },
        message("6", envelope()),
      ],
      persistBatch,
    });

    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch).toHaveBeenCalledWith([preceding]);
    expect(result.committablePrefix).toEqual([{ offset: "4", status: "inserted" }]);
    expect(result.nextOffset).toBe("5");
    expect(result.failure).toEqual({
      classification,
      topic: V2_TOPIC,
      partition: 0,
      offset: "5",
      errorName: classification === "malformed-json" ? "SyntaxError" : "Error",
    });
    expect(JSON.stringify(result)).not.toContain(payloadMarker);
  });

  test("fences an event routed to the wrong V2 partition", async () => {
    const persistBatch = jest.fn(async (events) => persistenceResult(events));
    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: [message("9", envelope("ETH-USD"))],
      persistBatch,
    });

    expect(result.failure).toMatchObject({
      classification: "partition-routing-violation",
      topic: V2_TOPIC,
      partition: 0,
      offset: "9",
    });
    expect(result.committableCount).toBe(0);
    expect(result.nextOffset).toBeNull();
    expect(persistBatch).not.toHaveBeenCalled();
  });

  test("stops after the first persistence failure and excludes later successes from the prefix", async () => {
    const events = [envelope(), envelope(), envelope()];
    const failure = new Error("database detail that must not be copied");
    const persistBatch = jest.fn(async (batchEvents) => ({
      results: [
        {
          index: 0,
          status: "inserted",
          eventIdentity: serializeSourceIdentity(batchEvents[0].source),
        },
        {
          index: 1,
          status: "failed",
          eventIdentity: serializeSourceIdentity(batchEvents[1].source),
          error: failure,
        },
        {
          index: 2,
          status: "replay",
          eventIdentity: serializeSourceIdentity(batchEvents[2].source),
        },
      ],
    }));

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: events.map((item, index) => message(String(20 + index), item)),
      persistBatch,
    });

    expect(result.committablePrefix).toEqual([{ offset: "20", status: "inserted" }]);
    expect(result.nextOffset).toBe("21");
    expect(result.failure).toEqual({
      classification: "persistence-failed",
      topic: V2_TOPIC,
      partition: 0,
      offset: "21",
      errorName: "Error",
    });
    expect(result.persistedAfterFailure).toEqual([{ offset: "22", status: "replay" }]);
    expect(JSON.stringify(result)).not.toContain("database detail");
  });

  test("does not start later chunks after a failure in the current persistence call", async () => {
    const events = Array.from({ length: 101 }, () => envelope());
    const persistBatch = jest.fn(async (batchEvents) => ({
      results: batchEvents.map((item, index) => ({
        index,
        status: index === 1 ? "failed" : "inserted",
        eventIdentity: serializeSourceIdentity(item.source),
      })),
    }));

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: events.map((item, index) => message(String(index), item)),
      persistBatch,
    });

    expect(persistBatch).toHaveBeenCalledTimes(1);
    expect(persistBatch.mock.calls[0][0]).toHaveLength(100);
    expect(result.committableCount).toBe(1);
    expect(result.nextOffset).toBe("1");
    expect(result.persistedAfterFailure).toHaveLength(98);
    expect(result.failure.offset).toBe("1");
  });

  test("does not commit an inserted result with a missing event identity", async () => {
    const persistBatch = jest.fn(async () => ({
      results: [{ index: 0, status: "inserted" }],
    }));

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: [message("40", envelope())],
      persistBatch,
    });

    expect(result.committablePrefix).toEqual([]);
    expect(result.nextOffset).toBeNull();
    expect(result.failure).toEqual({
      classification: "missing-persistence-identity",
      topic: V2_TOPIC,
      partition: 0,
      offset: "40",
    });
  });

  test("does not commit a replay result with a mismatched event identity", async () => {
    const persistBatch = jest.fn(async () => ({
      results: [{
        index: 0,
        status: "replay",
        eventIdentity: '["wrong","source","identity",0,"1"]',
      }],
    }));

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: [message("41", envelope())],
      persistBatch,
    });

    expect(result.committablePrefix).toEqual([]);
    expect(result.nextOffset).toBeNull();
    expect(result.failure).toEqual({
      classification: "persistence-identity-mismatch",
      topic: V2_TOPIC,
      partition: 0,
      offset: "41",
    });
    expect(JSON.stringify(result)).not.toContain("wrong");
  });

  test("preserves prior acknowledgements but fences a mismatched identity and later successes", async () => {
    const events = [envelope("BTC-USD", "101"), envelope("BTC-USD", "102"), envelope("BTC-USD", "103")];
    const persistBatch = jest.fn(async (batchEvents) => ({
      results: [
        {
          index: 0,
          status: "inserted",
          eventIdentity: serializeSourceIdentity(batchEvents[0].source),
        },
        {
          index: 1,
          status: "replay",
          eventIdentity: '["incorrect","identity","for-test",0,"102"]',
        },
        {
          index: 2,
          status: "inserted",
          eventIdentity: serializeSourceIdentity(batchEvents[2].source),
        },
      ],
    }));

    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: events.map((item, index) => message(String(50 + index), item)),
      persistBatch,
    });

    expect(result.committablePrefix).toEqual([{ offset: "50", status: "inserted" }]);
    expect(result.nextOffset).toBe("51");
    expect(result.failure).toEqual({
      classification: "persistence-identity-mismatch",
      topic: V2_TOPIC,
      partition: 0,
      offset: "51",
    });
    expect(result.persistedAfterFailure).toEqual([{ offset: "52", status: "inserted" }]);
    expect(JSON.stringify(result)).not.toContain("incorrect");
  });

  test("turns thrown persistence errors into a fenced, payload-free failure", async () => {
    const persistBatch = jest.fn().mockRejectedValue(new Error("private database message"));
    const result = await processHistoryPartitionBatch({
      partition: 2,
      messages: [message("9007199254740993", envelope("SOL-USD"))],
      persistBatch,
    });

    expect(result.failure).toEqual({
      classification: "persistence-batch-failed",
      topic: V2_TOPIC,
      partition: 2,
      offset: "9007199254740993",
      errorName: "Error",
    });
    expect(result.nextOffset).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private database message");
  });

  test.each([
    ["non-decimal", "1.5", "invalid-kafka-offset"],
    ["non-increasing", "7", "non-increasing-kafka-offset"],
  ])("rejects %s Kafka message offsets without advancing past the failure", async (
    _label,
    invalidOffset,
    classification,
  ) => {
    const persistBatch = jest.fn(async (events) => persistenceResult(events));
    const messages = classification === "non-increasing-kafka-offset"
      ? [message("7"), message(invalidOffset)]
      : [message(invalidOffset)];
    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages,
      persistBatch,
    });

    expect(result.failure.classification).toBe(classification);
    expect(result.failure.offset).toBe(invalidOffset);
    expect(result.nextOffset).toBe(
      classification === "non-increasing-kafka-offset" ? "8" : null,
    );
  });

  test("rejects a Kafka offset whose next offset cannot be represented", async () => {
    const persistBatch = jest.fn();
    const result = await processHistoryPartitionBatch({
      partition: 0,
      messages: [message("9223372036854775807")],
      persistBatch,
    });

    expect(result.failure.classification).toBe("next-kafka-offset-out-of-range");
    expect(result.nextOffset).toBeNull();
    expect(persistBatch).not.toHaveBeenCalled();
  });

  test("returns structured failure for a partition outside the six-partition topic", async () => {
    const persistBatch = jest.fn();
    const result = await processHistoryPartitionBatch({
      partition: 6,
      messages: [message("1")],
      persistBatch,
    });

    expect(result.failure).toEqual({
      classification: "invalid-kafka-partition",
      topic: V2_TOPIC,
      partition: 6,
      offset: null,
    });
    expect(persistBatch).not.toHaveBeenCalled();
  });
});
