const { loadRelayConfig } = require("../v2/relayConfig");
const { createRelayStartup } = require("../v2/relayStartup");

const relayConfig = loadRelayConfig({
  V1_SOURCE_CLUSTER_ID: "0jtOiYT4QmShqPK0HjBpQA",
  V1_SOURCE_TOPIC_GENERATION_ID: "9ShfnW90Th-vI4A2Jl1O4Q",
  V2_DESTINATION_CLUSTER_ID: "4L6g3nShT-eMCtK--X86sw",
});
const topicId = relayConfig.sourceIdentity.topicGenerationId;
const topicOutput = `Topic: crypto-prices TopicId: ${topicId} PartitionCount: 1 ReplicationFactor: 1 Configs: cleanup.policy=delete
  Topic: crypto-prices Partition: 0 Leader: 1 Replicas: 1 Isr: 1`;
const destinationTopicMetadata = {
  topics: [{
    name: relayConfig.v2Topic,
    partitions: [0, 1, 2, 3, 4, 5].map((partitionId) => ({
      partitionId,
      leader: 1,
      partitionErrorCode: 0,
    })),
  }],
};

function createHarness({
  command = jest.fn().mockResolvedValue({ stdout: topicOutput, stderr: "", exitCode: 0 }),
  clusterId = relayConfig.sourceIdentity.clusterId,
  destinationClusterId = relayConfig.destinationIdentity.clusterId,
  destinationMetadata = destinationTopicMetadata,
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
  const destinationAdmin = {
    connect: jest.fn(async () => events.push("destinationAdmin.connect")),
    disconnect: jest.fn(async () => events.push("destinationAdmin.disconnect")),
    describeCluster: jest.fn(async () => {
      events.push("destinationAdmin.describeCluster");
      return { clusterId: destinationClusterId };
    }),
    fetchTopicMetadata: jest.fn(async () => {
      events.push("destinationAdmin.fetchTopicMetadata");
      return destinationMetadata;
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
    destinationAdmin,
    executeCommand: command,
    createRunner,
  });

  return {
    admin,
    command,
    createRunner,
    destinationAdmin,
    events,
    runner,
    startup,
  };
}

test("completes all three identity checks and disconnects both admins before starting the runner", async () => {
  const harness = createHarness();
  harness.command.mockImplementation(async () => {
    harness.events.push("topic.preflight");
    return { stdout: topicOutput, stderr: "", exitCode: 0 };
  });
  await harness.startup.start();

  expect(harness.events).toEqual([
    "admin.connect",
    "destinationAdmin.connect",
    "topic.preflight",
    "admin.describeCluster",
    "destinationAdmin.describeCluster",
    "destinationAdmin.fetchTopicMetadata",
    "admin.disconnect",
    "destinationAdmin.disconnect",
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
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.events).toContain("admin.disconnect");
});

test("cluster-ID failure prevents runner creation", async () => {
  const harness = createHarness({ clusterId: "different-cluster" });

  await expect(harness.startup.start())
    .rejects.toThrow("Relay startup failed during V1 cluster-ID verification.");

  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
});

test.each([
  [
    "wrong V2 cluster",
    { destinationClusterId: relayConfig.sourceIdentity.clusterId },
    "V2 destination identity verification",
  ],
  [
    "missing V2 topic",
    { destinationMetadata: { topics: [] } },
    "V2 destination identity verification",
  ],
  [
    "wrong V2 partition count",
    {
      destinationMetadata: {
        topics: [{
          name: relayConfig.v2Topic,
          partitions: destinationTopicMetadata.topics[0].partitions.slice(0, 5),
        }],
      },
    },
    "V2 destination identity verification",
  ],
])("%s prevents relay startup and disconnects both admins", async (
  _name,
  options,
  stage,
) => {
  const harness = createHarness(options);

  await expect(harness.startup.start())
    .rejects.toThrow(`Relay startup failed during ${stage}.`);

  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.runner.start).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
});

test("V2 metadata failure prevents relay startup and sanitizes the error", async () => {
  const destinationAdminOptions = {
    destinationMetadata: null,
  };
  const harness = createHarness(destinationAdminOptions);
  harness.destinationAdmin.fetchTopicMetadata.mockRejectedValue(
    new Error("credential=secret"),
  );

  await expect(harness.startup.start())
    .rejects.toThrow("Relay startup failed during V2 destination identity verification.");

  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
});

test("cleans up a partially started runner and admin after startup failure", async () => {
  const harness = createHarness({
    runnerStart: jest.fn().mockRejectedValue(new Error("secret startup detail")),
  });

  await expect(harness.startup.start())
    .rejects.toThrow("Relay startup failed during relay runner startup.");

  expect(harness.runner.stop).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.events.indexOf("admin.disconnect"))
    .toBeLessThan(harness.events.indexOf("runner.create"));
  expect(harness.events.indexOf("destinationAdmin.disconnect"))
    .toBeLessThan(harness.events.indexOf("runner.create"));
  expect(harness.events.slice(-3)).toEqual([
    "runner.create",
    "runner.start",
    "runner.stop",
  ]);
});

test("duplicate starts share one startup and one relay runner", async () => {
  const harness = createHarness();
  const firstStart = harness.startup.start();
  const secondStart = harness.startup.start();

  expect(secondStart).toBe(firstStart);
  await Promise.all([firstStart, secondStart]);

  expect(harness.admin.connect).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.connect).toHaveBeenCalledTimes(1);
  expect(harness.command).toHaveBeenCalledTimes(1);
  expect(harness.admin.describeCluster).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.describeCluster).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.fetchTopicMetadata).toHaveBeenCalledTimes(1);
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
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
  expect(harness.destinationAdmin.disconnect).not.toHaveBeenCalled();

  resolvePreflight({ stdout: topicOutput, stderr: "", exitCode: 0 });

  await expect(startupPromise).rejects.toThrow("Relay startup cancelled.");
  await expect(shutdownPromise).resolves.toBeUndefined();
  expect(harness.createRunner).not.toHaveBeenCalled();
  expect(harness.runner.start).not.toHaveBeenCalled();
  expect(harness.admin.disconnect).toHaveBeenCalledTimes(1);
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
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
  expect(harness.destinationAdmin.disconnect).toHaveBeenCalledTimes(1);
  await expect(harness.startup.start()).rejects.toThrow("Relay startup has been stopped.");
});
