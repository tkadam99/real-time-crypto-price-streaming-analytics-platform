const {
  createEnvelope,
  serializeSourceIdentity,
} = require("../v2/eventContract");
const {
  HISTORY_CONSUMER_GROUP_ID,
  V2_TOPIC,
  createHistoryConsumerRunner,
} = require("../v2/historyConsumerRunner");

function envelope(sourceOffset = "12345678901234567") {
  return createEnvelope({
    symbol: "BTC-USD",
    price: 105.5,
    timestamp: "2026-01-01T00:01:00+00:00",
  }, {
    clusterId: "source-cluster",
    topicGenerationId: "source-generation",
    topic: "crypto-prices",
    partition: 4,
    offset: sourceOffset,
  });
}

function persistenceResult(events, statuses = []) {
  return {
    results: events.map((event, index) => ({
      index,
      status: statuses[index] || "inserted",
      eventIdentity: serializeSourceIdentity(event.source),
    })),
  };
}

function batchContext({
  partition = 0,
  offsets = ["9007199254740993"],
  events = offsets.map(() => envelope()),
  values,
  heartbeat = jest.fn().mockResolvedValue(),
  isRunning = jest.fn(() => true),
  isStale = jest.fn(() => false),
} = {}) {
  return {
    batch: {
      topic: V2_TOPIC,
      partition,
      messages: offsets.map((offset, index) => ({
        offset,
        value: values ? values[index] : Buffer.from(JSON.stringify(events[index])),
      })),
    },
    heartbeat,
    isRunning,
    isStale,
  };
}

function createHarness({
  persistBatch = jest.fn(async (events) => persistenceResult(events)),
  processBatch,
  config = {},
  commitOffsets = jest.fn().mockResolvedValue(),
  onFailure = jest.fn().mockResolvedValue(),
} = {}) {
  let runOptions;
  const consumer = {
    subscribe: jest.fn().mockResolvedValue(),
    run: jest.fn((options) => {
      runOptions = options;
      return Promise.resolve();
    }),
    commitOffsets,
    pause: jest.fn(),
    stop: jest.fn().mockResolvedValue(),
  };
  const runner = createHistoryConsumerRunner({
    consumer,
    processBatch,
    persistBatch,
    config: {
      groupId: HISTORY_CONSUMER_GROUP_ID,
      ...config,
    },
    onFailure,
  });
  return {
    consumer,
    runner,
    onFailure,
    persistBatch,
    getRunOptions: () => runOptions,
  };
}

describe("dependency-injected V2 history consumer runner", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test("subscribes only to V2 and disables Kafka auto-commit and batch resolution", async () => {
    const harness = createHarness();
    await harness.runner.start();

    expect(HISTORY_CONSUMER_GROUP_ID).toBe("crypto-v2-history-group");
    expect(harness.consumer.subscribe).toHaveBeenCalledWith({
      topic: V2_TOPIC,
      fromBeginning: true,
    });
    expect(harness.getRunOptions()).toMatchObject({
      autoCommit: false,
      eachBatchAutoResolve: false,
      partitionsConsumedConcurrently: 1,
    });
    expect(typeof harness.getRunOptions().eachBatch).toBe("function");
  });

  test("commits the exact contiguous V2 Kafka next offset, not the V1 source offset", async () => {
    const event = envelope("9223372036854775807");
    const harness = createHarness();
    await harness.runner.start();

    const context = batchContext({
      offsets: ["9007199254740993"],
      events: [event],
    });
    await harness.getRunOptions().eachBatch(context);

    expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
      topic: V2_TOPIC,
      partition: 0,
      offset: "9007199254740994",
    }]);
    expect(harness.consumer.commitOffsets.mock.calls[0][0][0].offset)
      .not.toBe(event.source.offset);
    expect(context.isRunning).toHaveBeenCalledTimes(2);
    expect(context.isStale).toHaveBeenCalledTimes(2);
    expect(harness.onFailure).not.toHaveBeenCalled();
  });

  test("commits only a verified prefix before reporting a malformed record", async () => {
    const valid = envelope();
    const harness = createHarness();
    await harness.runner.start();
    const terminalSignal = harness.runner.waitForTerminalFailure();

    await harness.getRunOptions().eachBatch(batchContext({
      offsets: ["10", "11", "12"],
      events: [valid, envelope(), envelope()],
      values: [
        Buffer.from(JSON.stringify(valid)),
        Buffer.from("{PRIVATE-PAYLOAD-SENTINEL"),
        Buffer.from(JSON.stringify(envelope())),
      ],
    }));

    expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
      topic: V2_TOPIC,
      partition: 0,
      offset: "11",
    }]);
    expect(harness.onFailure).toHaveBeenCalledWith({
      classification: "malformed-json",
      topic: V2_TOPIC,
      partition: 0,
      offset: "11",
      errorName: "SyntaxError",
    });
    expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("PRIVATE-PAYLOAD");
    expect(harness.consumer.pause).toHaveBeenCalledWith([{
      topic: V2_TOPIC,
    }]);
    await expect(terminalSignal).resolves.toEqual(harness.runner.getTerminalFailure());
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "malformed-json",
      partition: 0,
      offset: "11",
    });
    expect(harness.consumer.stop).not.toHaveBeenCalled();

    await harness.getRunOptions().eachBatch(batchContext({ offsets: ["13"] }));
    expect(harness.persistBatch).toHaveBeenCalledTimes(1);
    expect(harness.consumer.commitOffsets).toHaveBeenCalledTimes(1);

    await harness.runner.stop();
    expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  });

  test("does not commit when the heartbeat fails while persistence is in flight", async () => {
    jest.useFakeTimers();
    let finishProcessing;
    const processBatch = jest.fn(() => new Promise((resolve) => {
      finishProcessing = resolve;
    }));
    const heartbeat = jest.fn().mockRejectedValue(new Error("sensitive broker detail"));
    const harness = createHarness({
      processBatch,
      config: { heartbeatIntervalMs: 100 },
    });
    await harness.runner.start();

    const processing = harness.getRunOptions().eachBatch(batchContext({
      offsets: ["20"],
      heartbeat,
    }));
    await jest.advanceTimersByTimeAsync(100);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "heartbeat-failed",
      offset: "20",
    });

    finishProcessing({
      topic: V2_TOPIC,
      partition: 0,
      committablePrefix: [{ offset: "20", status: "inserted" }],
      committableCount: 1,
      nextOffset: "21",
      persistedAfterFailure: [],
      failure: null,
    });
    await processing;

    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(harness.onFailure).toHaveBeenCalledWith({
      classification: "heartbeat-failed",
      topic: V2_TOPIC,
      partition: 0,
      offset: "20",
      errorName: "Error",
    });
    expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("sensitive broker detail");
    expect(jest.getTimerCount()).toBe(0);
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "heartbeat-failed",
      offset: "20",
    });
  });

  test("does not commit if the assignment becomes stale before the commit", async () => {
    const harness = createHarness();
    await harness.runner.start();
    const context = batchContext({
      isStale: jest.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
    });

    await harness.getRunOptions().eachBatch(context);

    expect(context.isStale).toHaveBeenCalledTimes(2);
    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(harness.onFailure).not.toHaveBeenCalled();
  });

  test("surfaces commit failures without retrying", async () => {
    const harness = createHarness({
      commitOffsets: jest.fn().mockRejectedValue(new Error("private commit detail")),
    });
    await harness.runner.start();

    await harness.getRunOptions().eachBatch(batchContext({ offsets: ["30"] }));

    expect(harness.consumer.commitOffsets).toHaveBeenCalledTimes(1);
    expect(harness.onFailure).toHaveBeenCalledWith({
      classification: "offset-commit-failed",
      topic: V2_TOPIC,
      partition: 0,
      offset: "31",
      errorName: "Error",
    });
    expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("private commit detail");
    expect(harness.consumer.pause).toHaveBeenCalledWith([{
      topic: V2_TOPIC,
    }]);
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "offset-commit-failed",
      offset: "31",
    });

    await harness.getRunOptions().eachBatch(batchContext({ offsets: ["31"] }));
    expect(harness.consumer.commitOffsets).toHaveBeenCalledTimes(1);
  });

  test("makes persistence failures terminal and prevents later batches", async () => {
    const harness = createHarness({
      persistBatch: jest.fn(async (events) => ({
        results: events.map((_event, index) => ({
          index,
          status: "failed",
          error: new Error("private database detail"),
        })),
      })),
    });
    await harness.runner.start();

    await harness.getRunOptions().eachBatch(batchContext({ offsets: ["35"] }));

    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "persistence-failed",
      partition: 0,
      offset: "35",
      errorName: "Error",
    });
    expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("private database detail");

    await harness.getRunOptions().eachBatch(batchContext({ offsets: ["36"] }));
    expect(harness.persistBatch).toHaveBeenCalledTimes(1);
    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
  });

  test("times out a hanging heartbeat and lets eachBatch and cleanup finish", async () => {
    jest.useFakeTimers();
    let finishProcessing;
    const processBatch = jest.fn(() => new Promise((resolve) => {
      finishProcessing = resolve;
    }));
    const heartbeat = jest.fn(() => new Promise(() => {}));
    const harness = createHarness({
      processBatch,
      config: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 50 },
    });
    await harness.runner.start();

    const processing = harness.getRunOptions().eachBatch(batchContext({
      offsets: ["60"],
      heartbeat,
    }));
    await jest.advanceTimersByTimeAsync(150);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "heartbeat-timeout",
      offset: "60",
    });

    finishProcessing({
      topic: V2_TOPIC,
      partition: 0,
      committablePrefix: [{ offset: "60", status: "inserted" }],
      committableCount: 1,
      nextOffset: "61",
      persistedAfterFailure: [],
      failure: null,
    });
    await processing;
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "heartbeat-timeout",
      offset: "60",
    });
    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    await harness.runner.stop();
    expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  });

  test("observes a late heartbeat rejection after timeout without an unhandled rejection", async () => {
    jest.useFakeTimers();
    let rejectHeartbeat;
    let finishProcessing;
    const heartbeat = jest.fn(() => new Promise((_resolve, reject) => {
      rejectHeartbeat = reject;
    }));
    const processBatch = jest.fn(() => new Promise((resolve) => {
      finishProcessing = resolve;
    }));
    const harness = createHarness({
      processBatch,
      config: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 50 },
    });
    await harness.runner.start();

    const processing = harness.getRunOptions().eachBatch(batchContext({
      offsets: ["70"],
      heartbeat,
    }));
    const shutdown = harness.runner.stop();
    await jest.advanceTimersByTimeAsync(150);
    rejectHeartbeat(new Error("late private heartbeat detail"));
    finishProcessing({
      topic: V2_TOPIC,
      partition: 0,
      committablePrefix: [{ offset: "70", status: "replay" }],
      committableCount: 1,
      nextOffset: "71",
      persistedAfterFailure: [],
      failure: null,
    });
    await Promise.all([processing, shutdown]);

    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "heartbeat-timeout",
      offset: "70",
    });
    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("late private heartbeat detail");
    expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  });

  test("shutdown drains in-flight work without committing after shutdown starts", async () => {
    let finishProcessing;
    const processBatch = jest.fn(() => new Promise((resolve) => {
      finishProcessing = resolve;
    }));
    const harness = createHarness({ processBatch });
    await harness.runner.start();
    const processing = harness.getRunOptions().eachBatch(batchContext({ offsets: ["40"] }));
    const shutdown = harness.runner.stop();

    expect(harness.consumer.stop).not.toHaveBeenCalled();
    expect(harness.runner.stop()).toBe(shutdown);
    finishProcessing({
      topic: V2_TOPIC,
      partition: 0,
      committablePrefix: [{ offset: "40", status: "inserted" }],
      committableCount: 1,
      nextOffset: "41",
      persistedAfterFailure: [],
      failure: null,
    });
    await Promise.all([processing, shutdown]);

    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  });

  test("caps concurrent partitions and rejects an unsafe concurrency setting", async () => {
    const harness = createHarness({
      config: {
        groupId: HISTORY_CONSUMER_GROUP_ID,
        partitionsConsumedConcurrently: 2,
      },
    });
    await harness.runner.start();
    expect(harness.getRunOptions().partitionsConsumedConcurrently).toBe(2);

    expect(() => createHarness({
      config: { partitionsConsumedConcurrently: 3 },
    })).toThrow("partitionsConsumedConcurrently must be between 1 and 2.");
    expect(() => createHarness({
      config: { groupId: "crypto-analytics-group" },
    })).toThrow("History consumer must use its dedicated V2 group.");
  });

  test("rejects malformed core progress rather than committing an unverified offset", async () => {
    const processBatch = jest.fn(async () => ({
      topic: V2_TOPIC,
      partition: 0,
      committablePrefix: [{ offset: "50", status: "inserted" }],
      committableCount: 1,
      nextOffset: "9007199254740993",
      persistedAfterFailure: [],
      failure: null,
    }));
    const harness = createHarness({ processBatch });
    await harness.runner.start();

    await harness.getRunOptions().eachBatch(batchContext({ offsets: ["50"] }));

    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(harness.onFailure).toHaveBeenCalledWith({
      classification: "invalid-history-processing-result",
      topic: V2_TOPIC,
      partition: 0,
      offset: "50",
    });
  });
});
