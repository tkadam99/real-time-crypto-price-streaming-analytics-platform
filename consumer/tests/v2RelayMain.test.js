const { EventEmitter } = require("events");
const { createRelayApplication, createBoundedTopicCommandExecutor } = require("../v2/relayMain");

const env = {
  V1_SOURCE_CLUSTER_ID: "0jtOiYT4QmShqPK0HjBpQA",
  V1_SOURCE_TOPIC_GENERATION_ID: "9ShfnW90Th-vI4A2Jl1O4Q",
};
const topicId = env.V1_SOURCE_TOPIC_GENERATION_ID;
const topicOutput = `Topic: crypto-prices TopicId: ${topicId} PartitionCount: 1 ReplicationFactor: 1 Configs: cleanup.policy=delete
  Topic: crypto-prices Partition: 0 Leader: 1 Replicas: 1 Isr: 1`;
const successResult = { stdout: topicOutput, stderr: "", exitCode: 0 };

function createHarness({
  clusterId = env.V1_SOURCE_CLUSTER_ID,
  commandResult = successResult,
  executeCommand,
  producerConnect = jest.fn(async () => {}),
} = {}) {
  const events = [];
  const kafkaConfigs = [];
  let consumerConfig;
  const admin = {
    connect: jest.fn(async () => { events.push("admin.connect"); }),
    disconnect: jest.fn(async () => { events.push("admin.disconnect"); }),
    describeCluster: jest.fn(async () => {
      events.push("admin.describeCluster");
      return { clusterId };
    }),
  };
  const consumer = {
    connect: jest.fn(async () => { events.push("consumer.connect"); }),
    disconnect: jest.fn(async () => { events.push("consumer.disconnect"); }),
    subscribe: jest.fn(async () => { events.push("consumer.subscribe"); }),
    run: jest.fn(async () => { events.push("consumer.run"); }),
    commitOffsets: jest.fn(async () => {}),
    stop: jest.fn(async () => { events.push("consumer.stop"); }),
  };
  const producer = {
    connect: jest.fn(async () => {
      events.push("producer.connect");
      return producerConnect();
    }),
    disconnect: jest.fn(async () => { events.push("producer.disconnect"); }),
    send: jest.fn(async () => {}),
  };
  class KafkaMock {
    constructor(config) {
      kafkaConfigs.push(config);
    }

    admin() {
      return admin;
    }

    consumer(config) {
      consumerConfig = config;
      return consumer;
    }

    producer() {
      return producer;
    }
  }
  const command = executeCommand || jest.fn(async () => {
    events.push("topic.preflight");
    return commandResult;
  });
  const processObject = new EventEmitter();
  const logger = { error: jest.fn() };
  const application = createRelayApplication({
    env,
    KafkaConstructor: KafkaMock,
    executeCommand: command,
    processObject,
    logger,
  });

  return {
    admin,
    application,
    command,
    consumer,
    consumerConfig: () => consumerConfig,
    events,
    kafkaConfigs,
    logger,
    processObject,
    producer,
  };
}

test("wires separate V1 and V2 clients and verifies identities before relay activity", async () => {
  const harness = createHarness();

  expect(harness.kafkaConfigs).toEqual([
    { clientId: "crypto-v2-relay-v1", brokers: ["127.0.0.1:9092"] },
    { clientId: "crypto-v2-relay-v2", brokers: ["127.0.0.1:19092"] },
  ]);
  expect(harness.consumerConfig()).toEqual({
    groupId: "crypto-v2-relay-group",
    allowAutoTopicCreation: false,
  });

  await harness.application.start();

  expect(harness.events).toEqual([
    "admin.connect",
    "topic.preflight",
    "admin.describeCluster",
    "producer.connect",
    "consumer.connect",
    "consumer.subscribe",
    "consumer.run",
  ]);
  expect(harness.consumer.run).toHaveBeenCalledWith(expect.objectContaining({
    autoCommit: false,
    partitionsConsumedConcurrently: 1,
  }));
  await harness.application.stop();
});

test("topic-ID verification failure prevents V1 consumer startup", async () => {
  const harness = createHarness({
    commandResult: {
      stdout: topicOutput.replace(topicId, "9ShfnW90Th-vI4A2Jl1O4A"),
      stderr: "",
      exitCode: 0,
    },
  });

  await expect(harness.application.start())
    .rejects.toThrow("Relay startup failed during V1 topic-ID preflight.");

  expect(harness.consumer.connect).not.toHaveBeenCalled();
  expect(harness.consumer.subscribe).not.toHaveBeenCalled();
  expect(harness.producer.connect).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
});

test("cluster-ID verification failure prevents V1 consumer startup", async () => {
  const harness = createHarness({ clusterId: "wrong-cluster" });

  await expect(harness.application.start())
    .rejects.toThrow("Relay startup failed during V1 cluster-ID verification.");

  expect(harness.consumer.connect).not.toHaveBeenCalled();
  expect(harness.consumer.subscribe).not.toHaveBeenCalled();
  expect(harness.producer.connect).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
});

test("connection failure cleans up attempted clients without subscribing or committing", async () => {
  const harness = createHarness({
    producerConnect: jest.fn().mockRejectedValue(new Error("sensitive connection details")),
  });

  await expect(harness.application.start())
    .rejects.toThrow("Relay startup failed during relay runner startup.");

  expect(harness.producer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.consumer.connect).not.toHaveBeenCalled();
  expect(harness.consumer.subscribe).not.toHaveBeenCalled();
  expect(harness.consumer.commitOffsets).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
});

test("SIGTERM shuts down all clients and removes the signal handlers", async () => {
  const harness = createHarness();
  const signals = harness.application.installSignalHandlers();
  await harness.application.start();

  harness.processObject.emit("SIGTERM");
  await signals.waitForShutdown();

  expect(harness.consumer.stop).toHaveBeenCalledTimes(1);
  expect(harness.consumer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.producer.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.processObject.exitCode).toBe(143);
  expect(harness.processObject.listenerCount("SIGINT")).toBe(0);
  expect(harness.processObject.listenerCount("SIGTERM")).toBe(0);
});

test("SIGINT during startup cancels before connecting the relay producer or consumer", async () => {
  let resolvePreflight;
  let signalPreflightStarted;
  const preflightStarted = new Promise((resolve) => {
    signalPreflightStarted = resolve;
  });
  const deferredPreflight = new Promise((resolve) => {
    resolvePreflight = resolve;
  });
  const harness = createHarness({
    executeCommand: jest.fn(() => {
      harness.events.push("topic.preflight");
      signalPreflightStarted();
      return deferredPreflight;
    }),
  });
  const signals = harness.application.installSignalHandlers();
  const startup = harness.application.start();
  await preflightStarted;

  harness.processObject.emit("SIGINT");
  resolvePreflight(successResult);

  await expect(startup).rejects.toThrow("Relay startup cancelled.");
  await signals.waitForShutdown();
  expect(harness.consumer.connect).not.toHaveBeenCalled();
  expect(harness.consumer.subscribe).not.toHaveBeenCalled();
  expect(harness.producer.connect).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.processObject.exitCode).toBe(130);
});

test("bounded command executor uses only the approved argv with shell disabled", async () => {
  const execFileImpl = jest.fn((_command, _args, _options, callback) => {
    callback(null, topicOutput, "");
  });
  const executeCommand = createBoundedTopicCommandExecutor(execFileImpl);

  await executeCommand("docker", [
    "exec",
    "kafka",
    "kafka-topics",
    "--bootstrap-server",
    "localhost:9092",
    "--describe",
    "--topic",
    "crypto-prices",
  ], { shell: false });

  expect(execFileImpl).toHaveBeenCalledWith("docker", [
    "exec",
    "kafka",
    "kafka-topics",
    "--bootstrap-server",
    "localhost:9092",
    "--describe",
    "--topic",
    "crypto-prices",
  ], expect.objectContaining({
    shell: false,
    timeout: 15000,
    windowsHide: true,
  }), expect.any(Function));

  await expect(executeCommand("cmd.exe", ["/c", "whoami"], { shell: false }))
    .rejects.toThrow("Unsupported topic preflight command.");
  expect(execFileImpl).toHaveBeenCalledTimes(1);
});
