const { verifyV2Destination } = require("../v2/relayDestinationGuard");

const expectedClusterId = "test-v2-destination-cluster";
const relayConfig = {
  sourceIdentity: { clusterId: "test-v1-source-cluster" },
  v2Topic: "crypto-prices-v2",
  v2PartitionCount: 6,
};

function createTopicMetadata(partitionOverrides = {}) {
  return {
    topics: [{
      name: relayConfig.v2Topic,
      partitions: [0, 1, 2, 3, 4, 5].map((partitionId) => ({
        partitionId,
        leader: 1,
        partitionErrorCode: 0,
        ...partitionOverrides[partitionId],
      })),
    }],
  };
}

function createAdmin(options = {}) {
  const clusterId = Object.prototype.hasOwnProperty.call(options, "clusterId")
    ? options.clusterId
    : expectedClusterId;
  const topicMetadata = Object.prototype.hasOwnProperty.call(options, "topicMetadata")
    ? options.topicMetadata
    : createTopicMetadata();
  const events = [];
  return {
    events,
    connect: jest.fn(),
    disconnect: jest.fn(),
    describeCluster: jest.fn(async () => {
      events.push("describeCluster");
      return { clusterId };
    }),
    fetchTopicMetadata: jest.fn(async () => {
      events.push("fetchTopicMetadata");
      return topicMetadata;
    }),
  };
}

test("verifies cluster identity before the exact six-partition destination metadata", async () => {
  const admin = createAdmin();

  await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
    .resolves.toEqual({
      clusterId: expectedClusterId,
      topic: relayConfig.v2Topic,
      partitionCount: 6,
    });

  expect(admin.events).toEqual(["describeCluster", "fetchTopicMetadata"]);
  expect(admin.describeCluster).toHaveBeenCalledTimes(1);
  expect(admin.fetchTopicMetadata).toHaveBeenCalledWith({
    topics: ["crypto-prices-v2"],
  });
  expect(admin.connect).not.toHaveBeenCalled();
  expect(admin.disconnect).not.toHaveBeenCalled();
});

test("rejects a destination accidentally pointing at the V1 cluster", async () => {
  const admin = createAdmin({
    clusterId: relayConfig.sourceIdentity.clusterId,
  });

  await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
    .rejects.toThrow("does not match the configured destination identity");

  expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
});

test.each([undefined, null, "", "  "])(
  "rejects a missing live cluster ID %p",
  async (clusterId) => {
    const admin = createAdmin({ clusterId });

    await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
      .rejects.toThrow("cluster metadata is missing its cluster ID");
    expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
  },
);

test("rejects a missing expected cluster ID and prevents reuse of the V1 ID", async () => {
  const admin = createAdmin();

  await expect(verifyV2Destination(admin, relayConfig, undefined))
    .rejects.toThrow("Invalid V2 destination identity configuration.");
  await expect(verifyV2Destination(
    admin,
    relayConfig,
    relayConfig.sourceIdentity.clusterId,
  )).rejects.toThrow("Invalid V2 destination identity configuration.");
  expect(admin.describeCluster).not.toHaveBeenCalled();
});

test("sanitizes cluster and topic metadata request errors", async () => {
  const clusterAdmin = createAdmin();
  clusterAdmin.describeCluster.mockRejectedValue(
    new Error("password=private broker=secret.example"),
  );
  let clusterError;
  try {
    await verifyV2Destination(
      clusterAdmin,
      relayConfig,
      expectedClusterId,
    );
  } catch (caught) {
    clusterError = caught;
  }
  expect(clusterError.message).toBe("Unable to retrieve V2 Kafka cluster identity.");
  expect(clusterError.message).not.toContain("private");
  expect(clusterError.message).not.toContain("secret.example");

  const topicAdmin = createAdmin();
  topicAdmin.fetchTopicMetadata.mockRejectedValue(
    new Error("password=private broker=secret.example"),
  );
  await expect(verifyV2Destination(
    topicAdmin,
    relayConfig,
    expectedClusterId,
  )).rejects.toThrow("Unable to retrieve V2 Kafka topic metadata.");
});

test("rejects a missing destination topic", async () => {
  const admin = createAdmin({ topicMetadata: { topics: [] } });

  await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
    .rejects.toThrow("topic metadata is missing or unexpected");
});

test.each([5, 7])(
  "rejects a topic with %i partitions",
  async (partitionCount) => {
    const partitions = createTopicMetadata().topics[0].partitions.slice(
      0,
      partitionCount,
    );
    if (partitionCount === 7) {
      partitions.push({ partitionId: 6, leader: 1, partitionErrorCode: 0 });
    }
    const admin = createAdmin({
      topicMetadata: { topics: [{ name: relayConfig.v2Topic, partitions }] },
    });

    await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
      .rejects.toThrow("must have exactly six expected partitions");
  },
);

test("rejects missing or unexpected partition IDs", async () => {
  const partitions = createTopicMetadata().topics[0].partitions;
  partitions[2] = { partitionId: 6, leader: 1, partitionErrorCode: 0 };
  const admin = createAdmin({
    topicMetadata: { topics: [{ name: relayConfig.v2Topic, partitions }] },
  });

  await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
    .rejects.toThrow("must have exactly six expected partitions");
});

test.each([
  { leader: -1 },
  { leader: undefined },
])("rejects unavailable routed partition metadata: %p", async (metadata) => {
  const admin = createAdmin({
    topicMetadata: createTopicMetadata({ 1: metadata }),
  });

  await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
    .rejects.toThrow("A routed V2 Kafka destination partition is unavailable.");
});

test("rejects partition metadata errors outside the routed partitions", async () => {
  const admin = createAdmin({
    topicMetadata: createTopicMetadata({
      5: { partitionErrorCode: 5 },
    }),
  });

  await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
    .rejects.toThrow("V2 Kafka destination topic metadata reports a partition error.");
});

test("rejects malformed or ambiguous topic metadata", async () => {
  const admin = createAdmin({
    topicMetadata: {
      topics: [
        { name: relayConfig.v2Topic, partitions: createTopicMetadata().topics[0].partitions },
        { name: relayConfig.v2Topic, partitions: createTopicMetadata().topics[0].partitions },
      ],
    },
  });

  await expect(verifyV2Destination(admin, relayConfig, expectedClusterId))
    .rejects.toThrow("topic metadata is missing or unexpected");
});

test("rejects topic metadata API failures without exposing details", async () => {
  const admin = createAdmin();
  admin.fetchTopicMetadata.mockRejectedValue(
    new Error("password=private broker=secret.example"),
  );

  let error;
  try {
    await verifyV2Destination(admin, relayConfig, expectedClusterId);
  } catch (caught) {
    error = caught;
  }

  expect(error.message).toBe("Unable to retrieve V2 Kafka topic metadata.");
  expect(error.message).not.toContain("private");
  expect(error.message).not.toContain("secret.example");
});
