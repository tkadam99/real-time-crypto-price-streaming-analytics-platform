// Topic-generation identity still requires a separate mandatory preflight.
async function verifyV1ClusterIdentity(admin, relayConfig) {
  if (!admin || typeof admin.describeCluster !== "function") {
    throw new Error("Invalid Kafka admin client.");
  }
  const expectedClusterId = relayConfig && relayConfig.sourceIdentity &&
    relayConfig.sourceIdentity.clusterId;
  if (typeof expectedClusterId !== "string" || expectedClusterId.trim() === "") {
    throw new Error("Invalid relay configuration: source cluster ID is missing.");
  }

  let metadata;
  try {
    metadata = await admin.describeCluster();
  } catch {
    throw new Error("Unable to retrieve V1 Kafka cluster identity.");
  }

  const liveClusterId = metadata && metadata.clusterId;
  if (typeof liveClusterId !== "string" || liveClusterId.trim() === "") {
    throw new Error("V1 Kafka cluster metadata is missing its cluster ID.");
  }
  if (liveClusterId !== expectedClusterId) {
    throw new Error("Live V1 Kafka cluster ID does not match the configured source identity.");
  }

  return liveClusterId;
}

module.exports = { verifyV1ClusterIdentity };
