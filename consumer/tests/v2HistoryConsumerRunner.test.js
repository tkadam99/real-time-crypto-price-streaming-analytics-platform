jest.mock("../v2/historyPersistence", () => ({
  persistHistoryEvent: jest.fn(),
}));

const {
  createEnvelope,
  serializeSourceIdentity,
} = require("../v2/eventContract");
const { deriveEventIdentity } = require("../v2/historyContract");
const { persistHistoryEvent } = require("../v2/historyPersistence");
const { persistHistoryBatch } = require("../v2/historyBatch");
const { processHistoryPartitionBatch } = require("../v2/historyConsumerCore");
const {
  FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  LIVE_START_ACKNOWLEDGEMENT,
  loadHistoryConsumerConfig,
} = require("../v2/historyConsumerConfig");
const {
  HISTORY_CONSUMER_GROUP_ID,
  V2_TOPIC,
  createHistoryConsumerRunner,
} = require("../v2/historyConsumerRunner");

function envelope(sourceOffset = "12345678901234567", symbol = "BTC-USD") {
  return createEnvelope({
    symbol,
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

function smokeSettings(maxRecords = 3) {
  return loadHistoryConsumerConfig({
    V2_HISTORY_CONSUMER_ENABLED: "true",
    V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
    V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: String(maxRecords),
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "1000",
    V2_HISTORY_TOPIC_ID: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  }).firstRunSmoke;
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
    persistHistoryEvent.mockReset();
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

  describe("global smoke admission", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test("normal mode does not enable admission and malformed smoke settings fail closed", () => {
      expect(createHarness().runner.getAdmissionSnapshot()).toBeNull();
      for (const firstRunSmoke of [
        null,
        { enabled: false, maxRecords: 3, maxRuntimeMs: 1000 },
        { enabled: true, maxRecords: 3 },
        { enabled: true, maxRecords: 101, maxRuntimeMs: 1000 },
        { enabled: true, maxRecords: 3, maxRuntimeMs: 999 },
      ]) {
        expect(() => createHarness({ config: { firstRunSmoke } }))
          .toThrow("Invalid V2 history first-run smoke runner configuration.");
      }
    });

    test("concurrent partitions reserve one global cap before awaiting and commit only admitted prefixes", async () => {
      const releases = [];
      const persistBatch = jest.fn((events, { signal }) => new Promise((resolve) => {
        releases.push({ events, signal, resolve });
      }));
      const processBatch = jest.fn(processHistoryPartitionBatch);
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(3), partitionsConsumedConcurrently: 2 },
        processBatch,
        persistBatch,
      });
      await harness.runner.start();
      const first = batchContext({
        partition: 0,
        offsets: ["10", "11"],
        events: [envelope("1000"), envelope("1001")],
      });
      const second = batchContext({
        partition: 1,
        offsets: ["30", "31", "32"],
        events: [envelope("2000", "ETH-USD"), envelope("2001", "ETH-USD"),
          envelope("2002", "ETH-USD")],
      });

      const processingFirst = harness.getRunOptions().eachBatch(first);
      const processingSecond = harness.getRunOptions().eachBatch(second);
      expect(processBatch).toHaveBeenCalledTimes(2);
      expect(processBatch.mock.calls[0][0].messages).toEqual(first.batch.messages);
      expect(processBatch.mock.calls[1][0].messages).toEqual(second.batch.messages.slice(0, 1));
      expect(harness.runner.getAdmissionSnapshot()).toEqual({
        maxRecords: 3,
        admittedRecords: 3,
        remainingRecords: 0,
        closed: true,
        closeReason: "limit-reached",
      });
      expect(releases).toHaveLength(2);
      expect(releases.every(({ signal }) => !signal.aborted)).toBe(true);
      expect(harness.consumer.stop).not.toHaveBeenCalled();

      const unadmitted = batchContext({ partition: 2, offsets: ["50"] });
      await harness.getRunOptions().eachBatch(unadmitted);
      expect(processBatch).toHaveBeenCalledTimes(2);
      expect(persistBatch).toHaveBeenCalledTimes(2);
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.onFailure).not.toHaveBeenCalled();

      for (const pending of releases) {
        pending.resolve(persistenceResult(pending.events));
      }
      await Promise.all([processingFirst, processingSecond]);
      expect(harness.consumer.commitOffsets).toHaveBeenCalledTimes(2);
      expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
        topic: V2_TOPIC, partition: 0, offset: "12",
      }]);
      expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
        topic: V2_TOPIC, partition: 1, offset: "31",
      }]);
      expect(harness.consumer.stop).not.toHaveBeenCalled();
      await harness.runner.stop();
    });

    test("snapshots are frozen, reflect reservations, and retain the shutdown reason", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings(4) } });
      const before = harness.runner.getAdmissionSnapshot();
      await harness.runner.start();
      await harness.getRunOptions().eachBatch(batchContext({ offsets: ["10"] }));
      const after = harness.runner.getAdmissionSnapshot();
      expect(Object.isFrozen(before)).toBe(true);
      expect(Object.isFrozen(after)).toBe(true);
      expect(before).toMatchObject({ admittedRecords: 0, remainingRecords: 4, closed: false });
      expect(after).toMatchObject({ admittedRecords: 1, remainingRecords: 3, closed: false });
      await harness.runner.stop();
      expect(harness.runner.getAdmissionSnapshot()).toEqual({
        maxRecords: 4,
        admittedRecords: 1,
        remainingRecords: 3,
        closed: true,
        closeReason: "shutdown",
      });
      expect(after.closed).toBe(false);
    });

    test("malformed admitted records fence commits and permanently consume reservations", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings(3) } });
      await harness.runner.start();
      await harness.getRunOptions().eachBatch(batchContext({
        offsets: ["10", "11", "12", "13"],
        values: [
          Buffer.from(JSON.stringify(envelope("900"))),
          Buffer.from("{bad"),
          Buffer.from(JSON.stringify(envelope("901"))),
          Buffer.from(JSON.stringify(envelope("902"))),
        ],
      }));
      expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
        topic: V2_TOPIC, partition: 0, offset: "11",
      }]);
      expect(harness.runner.getTerminalFailure()).toMatchObject({
        classification: "malformed-json", offset: "11",
      });
      expect(harness.runner.getAdmissionSnapshot().admittedRecords).toBe(3);
      await harness.getRunOptions().eachBatch(batchContext({ offsets: ["14"] }));
      expect(harness.consumer.commitOffsets).toHaveBeenCalledTimes(1);
      await harness.runner.stop();
    });

    test("failed admitted writes fence later commits and do not refund capacity", async () => {
      const persistBatch = jest.fn(async (events) =>
        persistenceResult(events, ["inserted", "failed", "inserted"]));
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(3) },
        persistBatch,
      });
      await harness.runner.start();
      await harness.getRunOptions().eachBatch(batchContext({ offsets: ["20", "21", "22", "23"] }));
      expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
        topic: V2_TOPIC, partition: 0, offset: "21",
      }]);
      expect(harness.runner.getTerminalFailure()).toMatchObject({
        classification: "persistence-failed", offset: "21",
      });
      expect(harness.runner.getAdmissionSnapshot().admittedRecords).toBe(3);
      await harness.runner.stop();
    });

    test("rejects a core result that tries to commit an unreserved record", async () => {
      const processBatch = jest.fn(async () => ({
        topic: V2_TOPIC,
        partition: 0,
        committablePrefix: [
          { offset: "25", status: "inserted" },
          { offset: "26", status: "inserted" },
        ],
        committableCount: 2,
        nextOffset: "27",
        failure: null,
      }));
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(1) },
        processBatch,
      });
      await harness.runner.start();
      await harness.getRunOptions().eachBatch(batchContext({ offsets: ["25", "26"] }));

      expect(processBatch.mock.calls[0][0].messages).toHaveLength(1);
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.runner.getTerminalFailure()).toMatchObject({
        classification: "invalid-history-processing-result",
      });
      expect(harness.runner.getAdmissionSnapshot().admittedRecords).toBe(1);
      await harness.runner.stop();
    });

    test("shutdown cancels admitted work and preserves its reservation without committing", async () => {
      let finish;
      let signal;
      const processBatch = jest.fn(({ signal: inputSignal }) => {
        signal = inputSignal;
        return new Promise((resolve) => { finish = resolve; });
      });
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(3) },
        processBatch,
      });
      await harness.runner.start();
      const processing = harness.getRunOptions().eachBatch(batchContext({ offsets: ["40"] }));
      const stopping = harness.runner.stop();
      expect(signal.aborted).toBe(true);
      expect(harness.runner.getAdmissionSnapshot()).toMatchObject({
        admittedRecords: 1, closeReason: "shutdown",
      });
      finish({ cancelled: true });
      await Promise.all([processing, stopping]);
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.runner.getTerminalFailure()).toBeNull();
    });

    test("heartbeat failure aborts admitted work and prevents a commit", async () => {
      jest.useFakeTimers();
      let finish;
      let signal;
      const processBatch = jest.fn(({ signal: inputSignal }) => {
        signal = inputSignal;
        return new Promise((resolve) => { finish = resolve; });
      });
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(2), heartbeatIntervalMs: 100 },
        processBatch,
      });
      await harness.runner.start();
      const processing = harness.getRunOptions().eachBatch(batchContext({
        offsets: ["50"],
        heartbeat: jest.fn().mockRejectedValue(new Error("private heartbeat")),
      }));
      await jest.advanceTimersByTimeAsync(100);
      expect(signal.aborted).toBe(true);
      finish({ cancelled: true });
      await processing;
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.runner.getTerminalFailure()).toMatchObject({
        classification: "heartbeat-failed",
      });
      expect(harness.runner.getAdmissionSnapshot().admittedRecords).toBe(1);
      await harness.runner.stop();
    });

    test("stale admitted batches are not committed and keep their reservations", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings(2) } });
      await harness.runner.start();
      await harness.getRunOptions().eachBatch(batchContext({
        offsets: ["60"],
        isStale: jest.fn(() => true),
      }));
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.runner.getAdmissionSnapshot().admittedRecords).toBe(1);
      await harness.runner.stop();
    });

    test("commit errors remain terminal after an admitted prefix", async () => {
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(1) },
        commitOffsets: jest.fn().mockRejectedValue(new Error("private commit")),
      });
      await harness.runner.start();
      await harness.getRunOptions().eachBatch(batchContext({ offsets: ["70", "71"] }));
      expect(harness.consumer.commitOffsets).toHaveBeenCalledTimes(1);
      expect(harness.runner.getTerminalFailure()).toMatchObject({
        classification: "offset-commit-failed", offset: "71",
      });
      expect(harness.runner.getAdmissionSnapshot()).toMatchObject({
        admittedRecords: 1, closeReason: "limit-reached",
      });
      expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("private");
      await harness.runner.stop();
    });
  });

  describe("smoke runtime deadline", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      persistHistoryEvent.mockReset();
      jest.useRealTimers();
    });

    test("normal mode does not start a smoke deadline timer", async () => {
      const harness = createHarness();
      await harness.runner.start();
      expect(harness.runner.getRuntimeSnapshot()).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
      await harness.runner.stop();
    });

    test("starts the monotonic deadline at execution, not construction or subscription", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings() } });
      let finishSubscribe;
      harness.consumer.subscribe.mockImplementation(() => new Promise((resolve) => {
        finishSubscribe = resolve;
      }));
      const before = harness.runner.getRuntimeSnapshot();
      expect(Object.isFrozen(before)).toBe(true);
      expect(before).toEqual({ started: false, elapsedMs: 0, deadlineExpired: false });
      await jest.advanceTimersByTimeAsync(5000);
      const starting = harness.runner.start();
      await jest.advanceTimersByTimeAsync(5000);
      expect(harness.runner.getRuntimeSnapshot()).toEqual(before);
      expect(jest.getTimerCount()).toBe(0);
      finishSubscribe();
      await starting;
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(400);
      const running = harness.runner.getRuntimeSnapshot();
      expect(Object.isFrozen(running)).toBe(true);
      expect(running).toEqual({ started: true, elapsedMs: 400, deadlineExpired: false });
      jest.setSystemTime(Date.now() + 10000000);
      expect(harness.runner.getRuntimeSnapshot().elapsedMs).toBe(400);
      await jest.advanceTimersByTimeAsync(600);
      expect(harness.runner.getRuntimeSnapshot()).toEqual({
        started: true, elapsedMs: 1000, deadlineExpired: true,
      });
      expect(harness.runner.getAdmissionSnapshot().closeReason).toBe("deadline");
      expect(harness.runner.getTerminalFailure()).toBeNull();
      expect(harness.onFailure).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      await harness.runner.stop();
    });

    test("deadline cancels unstarted transactions and drains the active one before stop", async () => {
      let finishTransaction;
      let transactionStarted;
      const started = new Promise((resolve) => { transactionStarted = resolve; });
      persistHistoryEvent.mockImplementation(async ({ envelope: item }) => {
        transactionStarted();
        await new Promise((resolve) => { finishTransaction = resolve; });
        return { status: "inserted", eventIdentity: deriveEventIdentity(item) };
      });
      const persistBatch = (envelopes) => persistHistoryBatch({
        client: {},
        historyCollection: {},
        receiptCollection: {},
        envelopes,
        batchSize: envelopes.length,
        concurrency: 1,
      });
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(5) },
        persistBatch,
      });
      await harness.runner.start();
      let batchSettled = false;
      const processing = harness.getRunOptions().eachBatch(batchContext({
        offsets: ["10", "11", "12"],
      })).then(() => { batchSettled = true; });
      await started;
      await jest.advanceTimersByTimeAsync(1000);
      expect(harness.runner.getRuntimeSnapshot().deadlineExpired).toBe(true);
      expect(harness.runner.getAdmissionSnapshot()).toMatchObject({
        admittedRecords: 3, closeReason: "deadline",
      });
      expect(batchSettled).toBe(false);
      expect(persistHistoryEvent).toHaveBeenCalledTimes(1);
      await harness.getRunOptions().eachBatch(batchContext({ offsets: ["13"] }));
      expect(persistHistoryEvent).toHaveBeenCalledTimes(1);
      const stopping = harness.runner.stop();
      await Promise.resolve();
      expect(harness.consumer.stop).not.toHaveBeenCalled();
      finishTransaction();
      await Promise.all([processing, stopping]);
      expect(persistHistoryEvent).toHaveBeenCalledTimes(1);
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    });

    test("observes a late transaction rejection after the deadline and drains safely", async () => {
      let rejectTransaction;
      persistHistoryEvent.mockImplementation(() => new Promise((_resolve, reject) => {
        rejectTransaction = reject;
      }));
      const persistBatch = (envelopes) => persistHistoryBatch({
        client: {},
        historyCollection: {},
        receiptCollection: {},
        envelopes,
        concurrency: 1,
      });
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(2) },
        persistBatch,
      });
      await harness.runner.start();
      const processing = harness.getRunOptions().eachBatch(batchContext({ offsets: ["15"] }));
      await jest.advanceTimersByTimeAsync(1000);
      const stopping = harness.runner.stop();
      rejectTransaction(new Error("private MongoDB failure"));
      await expect(Promise.all([processing, stopping])).resolves.toBeDefined();
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.runner.getRuntimeSnapshot().deadlineExpired).toBe(true);
      expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("private");
      expect(jest.getTimerCount()).toBe(0);
    });

    test("a reached record cap does not hide a later deadline during persistence", async () => {
      let finish;
      let signal;
      const processBatch = jest.fn(({ signal: inputSignal }) => {
        signal = inputSignal;
        return new Promise((resolve) => { finish = resolve; });
      });
      const harness = createHarness({
        config: { firstRunSmoke: smokeSettings(1) },
        processBatch,
      });
      await harness.runner.start();
      const processing = harness.getRunOptions().eachBatch(batchContext({ offsets: ["20"] }));
      expect(harness.runner.getAdmissionSnapshot().closeReason).toBe("limit-reached");
      await jest.advanceTimersByTimeAsync(1000);
      expect(signal.aborted).toBe(true);
      expect(harness.runner.getAdmissionSnapshot().closeReason).toBe("limit-reached");
      expect(harness.runner.getRuntimeSnapshot().deadlineExpired).toBe(true);
      finish({ cancelled: true });
      await processing;
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      await harness.runner.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    test("a delayed timer cannot allow a commit after monotonic deadline", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings(1) } });
      await harness.runner.start();
      const now = performance.now();
      const clock = jest.spyOn(performance, "now").mockReturnValue(now + 1000);
      await harness.getRunOptions().eachBatch(batchContext({ offsets: ["30"] }));
      expect(harness.persistBatch).not.toHaveBeenCalled();
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.runner.getRuntimeSnapshot().deadlineExpired).toBe(true);
      clock.mockRestore();
      await harness.runner.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    test("checks the monotonic deadline immediately before issuing a commit", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings(1) } });
      await harness.runner.start();
      const now = performance.now();
      const clock = jest.spyOn(performance, "now");
      const context = batchContext({
        offsets: ["31"],
        isStale: jest.fn().mockImplementationOnce(() => false).mockImplementationOnce(() => {
          clock.mockReturnValue(now + 1000);
          return false;
        }),
      });
      await harness.getRunOptions().eachBatch(context);
      expect(harness.persistBatch).toHaveBeenCalledTimes(1);
      expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
      expect(harness.runner.getRuntimeSnapshot().deadlineExpired).toBe(true);
      clock.mockRestore();
      await harness.runner.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    test("terminal failure remains intact if the deadline subsequently expires", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings(2) } });
      await harness.runner.start();
      await harness.getRunOptions().eachBatch(batchContext({
        offsets: ["40"],
        values: [Buffer.from("{private")],
      }));
      const failure = harness.runner.getTerminalFailure();
      expect(failure.classification).toBe("malformed-json");
      await jest.advanceTimersByTimeAsync(1000);
      expect(harness.runner.getRuntimeSnapshot().deadlineExpired).toBe(true);
      expect(harness.runner.getTerminalFailure()).toBe(failure);
      expect(harness.onFailure).toHaveBeenCalledTimes(1);
      await harness.runner.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    test("repeated start and stop do not create or leave deadline timers", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings() } });
      await Promise.all([harness.runner.start(), harness.runner.start()]);
      expect(harness.consumer.run).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(250);
      const stopping = harness.runner.stop();
      expect(harness.runner.stop()).toBe(stopping);
      await stopping;
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(5000);
      expect(harness.runner.getRuntimeSnapshot()).toEqual({
        started: true, elapsedMs: 250, deadlineExpired: false,
      });
      expect(harness.runner.getAdmissionSnapshot().closeReason).toBe("shutdown");
      expect(harness.onFailure).not.toHaveBeenCalled();
      await expect(harness.runner.start()).rejects.toThrow("History consumer is stopping.");
    });

    test.each(["fulfilled", "rejected"])(
      "observes an already issued commit that settles %s after the deadline",
      async (outcome) => {
        let settleCommit;
        let commitStarted;
        const started = new Promise((resolve) => { commitStarted = resolve; });
        const commitOffsets = jest.fn(() => {
          commitStarted();
          return new Promise((resolve, reject) => {
            settleCommit = () => outcome === "fulfilled"
              ? resolve()
              : reject(new Error("private commit failure"));
          });
        });
        const harness = createHarness({
          config: { firstRunSmoke: smokeSettings(1) },
          commitOffsets,
        });
        await harness.runner.start();
        const processing = harness.getRunOptions().eachBatch(batchContext({ offsets: ["50"] }));
        await started;
        await jest.advanceTimersByTimeAsync(1000);
        expect(harness.runner.getRuntimeSnapshot().deadlineExpired).toBe(true);
        expect(harness.runner.getAdmissionSnapshot().closeReason).toBe("limit-reached");
        const stopping = harness.runner.stop();
        await Promise.resolve();
        expect(harness.consumer.stop).not.toHaveBeenCalled();
        settleCommit();
        await Promise.all([processing, stopping]);
        expect(commitOffsets).toHaveBeenCalledTimes(1);
        if (outcome === "rejected") {
          expect(harness.runner.getTerminalFailure()).toMatchObject({
            classification: "offset-commit-failed", offset: "51",
          });
          expect(JSON.stringify(harness.onFailure.mock.calls)).not.toContain("private");
        } else {
          expect(harness.runner.getTerminalFailure()).toBeNull();
        }
        expect(jest.getTimerCount()).toBe(0);
      },
    );

    test("clears the deadline timer if consumer.run throws during startup", async () => {
      const harness = createHarness({ config: { firstRunSmoke: smokeSettings() } });
      harness.consumer.run.mockImplementation(() => { throw new Error("private"); });
      await expect(harness.runner.start()).rejects.toThrow("Unable to start the V2 history consumer.");
      expect(jest.getTimerCount()).toBe(0);
      await expect(harness.runner.stop()).rejects.toThrow("history consumer startup");
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  test("heartbeat timeout stops admission of later persistence transactions", async () => {
    jest.useFakeTimers();
    let finishTransaction;
    let notifyTransactionStarted;
    const transactionStarted = new Promise((resolve) => {
      notifyTransactionStarted = resolve;
    });
    persistHistoryEvent.mockImplementation(async ({ envelope: item }) => {
      notifyTransactionStarted();
      await new Promise((resolve) => {
        finishTransaction = resolve;
      });
      return { status: "inserted", eventIdentity: deriveEventIdentity(item) };
    });
    const persistBatch = (envelopes) => persistHistoryBatch({
      client: {},
      historyCollection: {},
      receiptCollection: {},
      envelopes,
      batchSize: envelopes.length,
      concurrency: 1,
    });
    const harness = createHarness({
      persistBatch,
      config: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 50 },
    });
    await harness.runner.start();

    const processing = harness.getRunOptions().eachBatch(batchContext({
      offsets: ["80", "81", "82"],
      heartbeat: () => new Promise(() => {}),
    }));
    await transactionStarted;
    await jest.advanceTimersByTimeAsync(150);
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "heartbeat-timeout",
    });

    finishTransaction();
    await processing;

    expect(persistHistoryEvent).toHaveBeenCalledTimes(1);
    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    await harness.runner.stop();
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

  test("reports unexpected cancellation as an observable terminal failure without committing", async () => {
    const processBatch = jest.fn(async () => ({
      topic: V2_TOPIC,
      partition: 0,
      committablePrefix: [{ offset: "25", status: "inserted" }],
      committableCount: 1,
      nextOffset: "26",
      persistedAfterFailure: [],
      failure: null,
      cancelled: true,
    }));
    const harness = createHarness({ processBatch });
    await harness.runner.start();
    const terminalFailure = harness.runner.waitForTerminalFailure();

    await harness.getRunOptions().eachBatch(batchContext({ offsets: ["25"] }));

    await expect(terminalFailure).resolves.toMatchObject({
      classification: "history-processing-failed",
      topic: V2_TOPIC,
      partition: 0,
      offset: "25",
    });
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "history-processing-failed",
      offset: "25",
    });
    expect(harness.onFailure).toHaveBeenCalledTimes(1);
    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
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

  test("does not report duplicate failure for cancellation after heartbeat timeout", async () => {
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
      committablePrefix: [],
      committableCount: 0,
      nextOffset: null,
      persistedAfterFailure: [],
      failure: null,
      cancelled: true,
    });
    await processing;
    expect(harness.runner.getTerminalFailure()).toMatchObject({
      classification: "heartbeat-timeout",
      offset: "60",
    });
    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(harness.onFailure).toHaveBeenCalledTimes(1);
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

  test("expected shutdown cancellation drains in-flight work without reporting failure", async () => {
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
      committablePrefix: [],
      committableCount: 0,
      nextOffset: null,
      persistedAfterFailure: [],
      failure: null,
      cancelled: true,
    });
    await Promise.all([processing, shutdown]);

    expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
    expect(harness.runner.getTerminalFailure()).toBeNull();
    expect(harness.onFailure).not.toHaveBeenCalled();
    expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  });

  test("shutdown cancels later transaction admission in a multi-record batch", async () => {
    let finishTransaction;
    let notifyTransactionStarted;
    const transactionStarted = new Promise((resolve) => {
      notifyTransactionStarted = resolve;
    });
    persistHistoryEvent.mockImplementation(async ({ envelope: item }) => {
      notifyTransactionStarted();
      await new Promise((resolve) => {
        finishTransaction = resolve;
      });
      return { status: "inserted", eventIdentity: deriveEventIdentity(item) };
    });
    const persistBatch = (envelopes) => persistHistoryBatch({
      client: {},
      historyCollection: {},
      receiptCollection: {},
      envelopes,
      batchSize: envelopes.length,
      concurrency: 1,
    });
    const harness = createHarness({ persistBatch });
    await harness.runner.start();

    const processing = harness.getRunOptions().eachBatch(batchContext({
      offsets: ["90", "91", "92"],
    }));
    await transactionStarted;
    const shutdown = harness.runner.stop();
    finishTransaction();
    await Promise.all([processing, shutdown]);

    expect(persistHistoryEvent).toHaveBeenCalledTimes(1);
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
