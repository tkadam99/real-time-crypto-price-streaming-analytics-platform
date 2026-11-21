const { parseEnvelope } = require("../v2/eventContract");
const {
  RELAY_CONSUMER_GROUP_ID,
  V1_TOPIC,
  V2_TOPIC,
  createRelayRunner,
} = require("../v2/relayRunner");

const sourceIdentity = {
  clusterId: "legacy-cluster",
  topicGenerationId: "crypto-prices-generation-1",
};
const payload = {
  topic: V1_TOPIC,
  partition: 2,
  message: {
    offset: "9007199254740993",
    value: Buffer.from(JSON.stringify({
      symbol: "ETH-USD",
      price: 105.5,
      timestamp: "2026-01-01T00:01:00+00:00",
    })),
  },
};

function createHarness({ send = jest.fn().mockResolvedValue([]) } = {}) {
  let runOptions;
  const consumer = {
    subscribe: jest.fn().mockResolvedValue(),
    run: jest.fn(async (options) => { runOptions = options; }),
    commitOffsets: jest.fn().mockResolvedValue(),
    stop: jest.fn().mockResolvedValue(),
  };
  const producer = { send };
  const runner = createRelayRunner({
    consumer,
    producer,
    sourceIdentity,
    v2PartitionCount: 6,
  });
  return {
    consumer,
    producer,
    runner,
    getRunOptions: () => runOptions,
  };
}

test("subscribes to V1 with a distinct relay group and runs sequentially without auto-commit", async () => {
  const harness = createHarness();

  expect(RELAY_CONSUMER_GROUP_ID).not.toBe("crypto-analytics-group");
  expect(RELAY_CONSUMER_GROUP_ID).not.toBe("crypto-current-price-group");
  await harness.runner.start();

  expect(harness.consumer.subscribe).toHaveBeenCalledWith({
    topic: "crypto-prices",
    fromBeginning: false,
  });
  expect(harness.getRunOptions()).toMatchObject({
    autoCommit: false,
    partitionsConsumedConcurrently: 1,
  });
});

test("publishes the normalized record before committing its exact next offset", async () => {
  const order = [];
  const harness = createHarness({
    send: jest.fn(async (request) => {
      order.push("publish");
      expect(request.topic).toBe(V2_TOPIC);
      expect(request.messages).toHaveLength(1);
      expect(request.messages[0]).toMatchObject({
        key: Buffer.from("ETH-USD", "utf8"),
        partition: 1,
      });
      const envelope = parseEnvelope(request.messages[0].value);
      expect(envelope.source).toEqual({
        ...sourceIdentity,
        topic: V1_TOPIC,
        partition: payload.partition,
        offset: payload.message.offset,
      });
    }),
  });
  harness.consumer.commitOffsets.mockImplementation(async () => order.push("commit"));
  await harness.runner.start();
  await harness.getRunOptions().eachMessage(payload);

  expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
    topic: V1_TOPIC,
    partition: payload.partition,
    offset: "9007199254740994",
  }]);
  expect(order).toEqual(["publish", "commit"]);
});

test("does not commit when V2 publication fails", async () => {
  const harness = createHarness({
    send: jest.fn().mockRejectedValue(new Error("publish failed")),
  });
  await harness.runner.start();

  await expect(harness.getRunOptions().eachMessage(payload))
    .rejects.toThrow("publish failed");
  expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
});

test("propagates commit failure without retrying or republishing", async () => {
  const commitError = new Error("commit failed");
  const harness = createHarness();
  harness.consumer.commitOffsets.mockRejectedValue(commitError);
  await harness.runner.start();

  await expect(harness.getRunOptions().eachMessage(payload)).rejects.toBe(commitError);

  expect(harness.producer.send).toHaveBeenCalledTimes(1);
  expect(harness.consumer.commitOffsets).toHaveBeenCalledTimes(1);
  expect(harness.consumer.commitOffsets).toHaveBeenCalledWith([{
    topic: V1_TOPIC,
    partition: payload.partition,
    offset: "9007199254740994",
  }]);
});

test("does not publish or commit when transformation fails", async () => {
  const harness = createHarness();
  await harness.runner.start();

  await expect(harness.getRunOptions().eachMessage({
    ...payload,
    message: { ...payload.message, value: Buffer.from("{") },
  })).rejects.toThrow(SyntaxError);
  expect(harness.producer.send).not.toHaveBeenCalled();
  expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
});

test("shutdown waits for in-flight publication and its subsequent commit", async () => {
  let finishPublish;
  const order = [];
  const harness = createHarness({
    send: jest.fn(() => new Promise((resolve) => {
      finishPublish = () => {
        order.push("publish");
        resolve([]);
      };
    })),
  });
  harness.consumer.commitOffsets.mockImplementation(async () => order.push("commit"));
  await harness.runner.start();

  const processing = harness.getRunOptions().eachMessage(payload);
  const shutdown = harness.runner.stop();
  let shutdownFinished = false;
  void shutdown.then(() => { shutdownFinished = true; });
  await Promise.resolve();

  expect(shutdownFinished).toBe(false);
  expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
  finishPublish();
  await Promise.all([processing, shutdown]);

  expect(order).toEqual(["publish", "commit"]);
});
