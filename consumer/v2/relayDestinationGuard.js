const V2_TOPIC = "crypto-prices-v2";
const V2_PARTITION_COUNT = 6;
const REQUIRED_PARTITION_IDS = [0, 1, 2, 3, 4, 5];
const ROUTED_PARTITION_IDS = [0, 1, 2];

async function verifyV2Destination(admin, relayConfig, expectedClusterId) {
  if (!admin || typeof admin.describeCluster !== "function" ||
      typeof admin.fetchTopicMetadata !== "function") {
    throw new Error("Invalid Kafka admin client for V2 destination verification.");
  }
  if (!relayConfig || relayConfig.v2Topic !== V2_TOPIC ||
      relayConfig.v2PartitionCount !== V2_PARTITION_COUNT ||
      !relayConfig.sourceIdentity ||
      typeof relayConfig.sourceIdentity.clusterId !== "string" ||
      relayConfig.sourceIdentity.clusterId.trim() === "" ||
      typeof expectedClusterId !== "string" ||
      expectedClusterId.trim() === "" ||
      expectedClusterId !== expectedClusterId.trim() ||
      expectedClusterId === relayConfig.sourceIdentity.clusterId) {
    throw new Error("Invalid V2 destination identity configuration.");
  }

  let clusterMetadata;
  try {
    clusterMetadata = await admin.describeCluster();
  } catch {
    throw new Error("Unable to retrieve V2 Kafka cluster identity.");
  }

  const liveClusterId = clusterMetadata && clusterMetadata.clusterId;
  if (typeof liveClusterId !== "string" || liveClusterId.trim() === "") {
    throw new Error("V2 Kafka cluster metadata is missing its cluster ID.");
  }
  if (liveClusterId !== expectedClusterId) {
    throw new Error("Live V2 Kafka cluster ID does not match the configured destination identity.");
  }

  let topicMetadata;
  try {
    topicMetadata = await admin.fetchTopicMetadata({ topics: [V2_TOPIC] });
  } catch {
    throw new Error("Unable to retrieve V2 Kafka topic metadata.");
  }

  const topics = topicMetadata && topicMetadata.topics;
  if (!Array.isArray(topics) || topics.length !== 1 ||
      !topics[0] || topics[0].name !== V2_TOPIC ||
      !Array.isArray(topics[0].partitions)) {
    throw new Error("V2 Kafka destination topic metadata is missing or unexpected.");
  }

  const partitions = topics[0].partitions;
  const partitionIds = partitions.map((partition) => partition && partition.partitionId);
  if (partitions.length !== V2_PARTITION_COUNT ||
      partitionIds.some((partitionId) => !Number.isInteger(partitionId)) ||
      new Set(partitionIds).size !== V2_PARTITION_COUNT ||
      REQUIRED_PARTITION_IDS.some((partitionId) => !partitionIds.includes(partitionId))) {
    throw new Error("V2 Kafka destination topic must have exactly six expected partitions.");
  }
  if (partitions.some((partition) => partition.partitionErrorCode !== 0)) {
    throw new Error("V2 Kafka destination topic metadata reports a partition error.");
  }

  for (const partitionId of ROUTED_PARTITION_IDS) {
    const partition = partitions.find((candidate) =>
      candidate.partitionId === partitionId);
    if (!Number.isInteger(partition.leader) || partition.leader < 0) {
      throw new Error("A routed V2 Kafka destination partition is unavailable.");
    }
  }

  return {
    clusterId: liveClusterId,
    topic: V2_TOPIC,
    partitionCount: V2_PARTITION_COUNT,
  };
}

module.exports = { verifyV2Destination };
