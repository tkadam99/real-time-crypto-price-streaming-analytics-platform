const { verifyV1ClusterIdentity } = require("../v2/relayIdentityGuard");

const relayConfig = {
  sourceIdentity: {
    clusterId: "0jtOiYT4QmShqPK0HjBpQA",
    topicGenerationId: "9ShfnW90Th-vI4A2Jl1O4Q",
  },
};

function createAdmin(metadata) {
  return {
    describeCluster: jest.fn().mockResolvedValue(metadata),
    fetchTopicMetadata: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
  };
}

test("accepts a matching live cluster ID without connecting or checking topic metadata", async () => {
  const admin = createAdmin({ clusterId: relayConfig.sourceIdentity.clusterId });

  await expect(verifyV1ClusterIdentity(admin, relayConfig))
    .resolves.toBe(relayConfig.sourceIdentity.clusterId);

  expect(admin.describeCluster).toHaveBeenCalledTimes(1);
  expect(admin.fetchTopicMetadata).not.toHaveBeenCalled();
  expect(admin.connect).not.toHaveBeenCalled();
  expect(admin.disconnect).not.toHaveBeenCalled();
});

test("rejects a mismatched live cluster ID", async () => {
  const admin = createAdmin({ clusterId: "different-cluster" });

  await expect(verifyV1ClusterIdentity(admin, relayConfig))
    .rejects.toThrow("does not match the configured source identity");
});

test.each([undefined, null, "", "  "])(
  "rejects missing live cluster ID %p",
  async (clusterId) => {
    const admin = createAdmin({ clusterId });

    await expect(verifyV1ClusterIdentity(admin, relayConfig))
      .rejects.toThrow("metadata is missing its cluster ID");
  },
);

test("fails closed and sanitizes metadata request errors", async () => {
  const admin = createAdmin();
  admin.describeCluster.mockRejectedValue(
    new Error("SASL password=private; broker=secret.example"),
  );

  let error;
  try {
    await verifyV1ClusterIdentity(admin, relayConfig);
  } catch (caught) {
    error = caught;
  }

  expect(error.message).toBe("Unable to retrieve V1 Kafka cluster identity.");
  expect(error.message).not.toContain("private");
  expect(error.message).not.toContain("secret.example");
});
