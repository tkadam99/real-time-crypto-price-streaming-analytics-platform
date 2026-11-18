const { loadRelayConfig } = require("../v2/relayConfig");
const { createRelayStartup } = require("../v2/relayStartup");

const relayConfig = loadRelayConfig({
  V1_SOURCE_CLUSTER_ID: "0jtOiYT4QmShqPK0HjBpQA",
  V1_SOURCE_TOPIC_GENERATION_ID: "9ShfnW90Th-vI4A2Jl1O4Q",
});
const topicId = relayConfig.sourceIdentity.topicGenerationId;
const topicOutput = `Topic: crypto-prices TopicId: ${topicId} PartitionCount: 1 ReplicationFactor: 1 Configs: cleanup.policy=delete
  Topic: crypto-prices Partition: 0 Leader: 1 Replicas: 1 Isr: 1`;

function createHarness({
  command = jest.fn().mockResolvedValue({ stdout: topicOutput, stderr: "", exitCode: 0 }),
  clusterId = relayConfig.sourceIdentity.clusterId,
  runnerStart = jest.fn().mockResolvedValue(),
} = {}) {
  const events = [];
  const admin = {
    connect: jest.fn(async () => events.push("admin.connect")),
    disconnect: jest.fn(async () => events.push("admin.disconnect")),
    describeCluster: jest.fn(async () => {
      events.push("admin.describeCluster");
      return { clusterId };
    }),
  };
  const runner = {
    start: jest.fn(async () => {
      events.push("runner.start");
      return runnerStart();
    }),
    stop: jest.fn(async () => events.push("runner.stop")),
  };
  const createRunner = jest.fn(() => {
    events.push("runner.create");
    return runner;
  });
  const startup = createRelayStartup({
    relayConfig,
    admin,
    executeCommand: command,
    createRunner,
  });

  return { admin, command, createRunner, events, runner, startup };
}

test("completes both identity checks before creating and starting the runner", async () => {
  const harness = createHarness();
  harness.command.mockImplementation(async () => {
    harness.events.push("topic.preflight");
    return { stdout: topicOutput, stderr: "", exitCode: 0 };
  });
  await harness.startup.start();

  expect(harness.events).toEqual([
    "admin.connect",
    "topic.preflight",
    "admin.describeCluster",
    "runner.create",
    "runner.start",
  ]);
});

test("topic-ID failure prevents runner creation and disconnects the admin", async () => {
  const command = jest.fn().mockRejectedValue(new Error("secret credential detail"));
  const harness = createHarness({ command });

  let error;
  try {
    await harness.startup.start();
  } catch (caught) {
    error = caught;
  }

  expect(error.message).toBe("Relay startup failed during V1 topic-ID preflight.");
  expect(error.message).not.toContain("secret");
  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.admin.describeCluster).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.events).toContain("admin.disconnect");
});

test("cluster-ID failure prevents runner creation", async () => {
  const harness = createHarness({ clusterId: "different-cluster" });

  await expect(harness.startup.start())
    .rejects.toThrow("Relay startup failed during V1 cluster-ID verification.");

  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
});

test("cleans up a partially started runner and admin after startup failure", async () => {
  const harness = createHarness({
    runnerStart: jest.fn().mockRejectedValue(new Error("secret startup detail")),
  });

  await expect(harness.startup.start())
    .rejects.toThrow("Relay startup failed during relay runner startup.");

  expect(harness.runner.stop).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.events.slice(-2)).toEqual(["runner.stop", "admin.disconnect"]);
});

test("duplicate starts share one startup and one relay runner", async () => {
  const harness = createHarness();
  const firstStart = harness.startup.start();
  const secondStart = harness.startup.start();

  expect(secondStart).toBe(firstStart);
  await Promise.all([firstStart, secondStart]);

  expect(harness.admin.connect).toHaveBeenCalledTimes(1);
  expect(harness.command).toHaveBeenCalledTimes(1);
  expect(harness.admin.describeCluster).toHaveBeenCalledTimes(1);
  expect(harness.createRunner).toHaveBeenCalledTimes(1);
  expect(harness.runner.start).toHaveBeenCalledTimes(1);
});

test("shutdown during topic preflight cancels startup and waits for cleanup", async () => {
  let resolvePreflight;
  let signalPreflightStarted;
  const preflightStarted = new Promise((resolve) => {
    signalPreflightStarted = resolve;
  });
  const preflightResult = new Promise((resolve) => {
    resolvePreflight = resolve;
  });
  const command = jest.fn(() => {
    signalPreflightStarted();
    return preflightResult;
  });
  const harness = createHarness({ command });

  const startupPromise = harness.startup.start();
  await preflightStarted;
  const shutdownPromise = harness.startup.stop();
  let shutdownCompleted = false;
  void shutdownPromise.then(() => { shutdownCompleted = true; });
  expect(shutdownCompleted).toBe(false);
  expect(harness.admin.disconnect).not.toHaveBeenCalled();

  resolvePreflight({ stdout: topicOutput, stderr: "", exitCode: 0 });

  await expect(startupPromise).rejects.toThrow("Relay startup cancelled.");
  await expect(shutdownPromise).resolves.toBeUndefined();
  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.runner.start).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
});

test("shutdown is safe and idempotent", async () => {
  const harness = createHarness();
  await harness.startup.start();

  const firstStop = harness.startup.stop();
  const secondStop = harness.startup.stop();
  expect(secondStop).toBe(firstStop);
  await Promise.all([firstStop, secondStop]);

  expect(harness.runner.stop).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  await expect(harness.startup.start()).rejects.toThrow("Relay startup has been stopped.");
});
