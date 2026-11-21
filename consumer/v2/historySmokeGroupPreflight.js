const {
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  HISTORY_CONSUMER_GROUP_ID,
  HISTORY_KAFKA_BROKER,
  HISTORY_KAFKA_CLUSTER_ID,
  HISTORY_TOPIC,
} = require("./historyConsumerConfig");

const PARTITION_IDS = Object.freeze([0, 1, 2, 3, 4, 5]);
const KAFKAJS_CONSUMER_PROTOCOL = "consumer";
const KAFKAJS_DEFAULT_ASSIGNER_PROTOCOL = "RoundRobinAssigner";
// KafkaJS 2.2.4 preserves Kafka's missing committed-offset sentinel as a string.
const UNCOMMITTED_OFFSET = "-1";

function hasExactKeys(value, requiredKeys, optionalKeys = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  return requiredKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowedKeys.has(key));
}

function hasSuccessfulOptionalErrorCode(value) {
  return !Object.prototype.hasOwnProperty.call(value, "errorCode") ||
    value.errorCode === 0;
}

function validateSmokeConfiguration(config) {
  if (!config || config.enabled !== true ||
      config.liveStartAcknowledged !== true ||
      !config.firstRunSmoke ||
      config.firstRunSmoke.enabled !== true ||
      !Number.isInteger(config.firstRunSmoke.maxRecords) ||
      config.firstRunSmoke.maxRecords < 1 ||
      config.firstRunSmoke.maxRecords > 100 ||
      !Number.isInteger(config.firstRunSmoke.maxRuntimeMs) ||
      config.firstRunSmoke.maxRuntimeMs < 1000 ||
      config.firstRunSmoke.maxRuntimeMs > 300000 ||
      !config.kafka ||
      config.kafka.broker !== HISTORY_KAFKA_BROKER ||
      config.kafka.clusterId !== HISTORY_KAFKA_CLUSTER_ID ||
      config.kafka.topic !== HISTORY_TOPIC ||
      config.kafka.topicPartitionCount !== PARTITION_IDS.length ||
      config.kafka.expectedTopicId !== FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID ||
      !config.consumer ||
      config.consumer.groupId !== HISTORY_CONSUMER_GROUP_ID) {
    throw new Error("Invalid V2 history smoke group preflight configuration.");
  }
}

function validateAdmin(admin) {
  if (!admin || typeof admin.listGroups !== "function" ||
      typeof admin.describeGroups !== "function" ||
      typeof admin.fetchOffsets !== "function") {
    throw new Error("Invalid Kafka Admin dependency for V2 history smoke group preflight.");
  }
}

function validateGroupList(response) {
  if (!hasExactKeys(response, ["groups"]) || !Array.isArray(response.groups)) {
    throw new Error("V2 history smoke group list is malformed or incomplete.");
  }

  const seenGroupIds = new Set();
  let targetGroup = null;
  for (const group of response.groups) {
    if (!hasExactKeys(group, ["groupId", "protocolType"]) ||
        typeof group.groupId !== "string" ||
        group.groupId.trim() === "" ||
        group.groupId.trim() !== group.groupId ||
        typeof group.protocolType !== "string" ||
        group.protocolType.trim() === "" ||
        group.protocolType.trim() !== group.protocolType ||
        seenGroupIds.has(group.groupId)) {
      throw new Error("V2 history smoke group list is malformed or ambiguous.");
    }
    seenGroupIds.add(group.groupId);
    if (group.groupId === HISTORY_CONSUMER_GROUP_ID) {
      targetGroup = group;
    }
  }

  if (targetGroup && targetGroup.protocolType !== KAFKAJS_CONSUMER_PROTOCOL) {
    throw new Error("V2 history smoke group has unexpected protocol metadata.");
  }
  return targetGroup;
}

function validateGroupDescription(response) {
  if (!hasExactKeys(response, ["groups"]) ||
      !Array.isArray(response.groups) ||
      response.groups.length !== 1) {
    throw new Error("V2 history smoke group description is malformed or ambiguous.");
  }

  const [group] = response.groups;
  if (!hasExactKeys(
    group,
    ["groupId", "state", "protocolType", "protocol", "members"],
    ["errorCode"],
  ) ||
      group.groupId !== HISTORY_CONSUMER_GROUP_ID ||
      !hasSuccessfulOptionalErrorCode(group) ||
      group.protocolType !== KAFKAJS_CONSUMER_PROTOCOL ||
      !["", KAFKAJS_DEFAULT_ASSIGNER_PROTOCOL].includes(group.protocol) ||
      group.state !== "Empty" ||
      !Array.isArray(group.members) ||
      group.members.length !== 0) {
    throw new Error("V2 history smoke group is not empty or has unexpected metadata.");
  }
}

function validateUncommittedOffsets(response) {
  if (!Array.isArray(response) || response.length !== 1) {
    throw new Error("V2 history smoke group offsets are malformed or ambiguous.");
  }

  const [topicOffsets] = response;
  if (!hasExactKeys(topicOffsets, ["topic", "partitions"]) ||
      topicOffsets.topic !== HISTORY_TOPIC ||
      !Array.isArray(topicOffsets.partitions) ||
      topicOffsets.partitions.length !== PARTITION_IDS.length) {
    throw new Error("V2 history smoke group offsets do not cover the expected topic.");
  }

  const seenPartitions = new Set();
  for (const partition of topicOffsets.partitions) {
    if (!hasExactKeys(
      partition,
      ["partition", "offset", "metadata"],
      ["errorCode"],
    ) ||
        !hasSuccessfulOptionalErrorCode(partition) ||
        !Number.isInteger(partition.partition) ||
        !PARTITION_IDS.includes(partition.partition) ||
        seenPartitions.has(partition.partition) ||
        typeof partition.offset !== "string" ||
        partition.offset !== UNCOMMITTED_OFFSET ||
        partition.metadata !== null) {
      throw new Error("V2 history smoke group has committed or ambiguous offsets.");
    }
    seenPartitions.add(partition.partition);
  }

  if (seenPartitions.size !== PARTITION_IDS.length) {
    throw new Error("V2 history smoke group offsets do not cover all partitions.");
  }
}

async function verifyHistorySmokeGroup({ admin, config } = {}) {
  validateSmokeConfiguration(config);
  validateAdmin(admin);

  let groupList;
  try {
    groupList = await admin.listGroups();
  } catch {
    throw new Error("Unable to retrieve V2 history Kafka group list.");
  }

  const targetGroup = validateGroupList(groupList);
  if (!targetGroup) {
    await verifyNoCommittedOffsets(admin);
    return Object.freeze({
      status: "absent",
      groupId: HISTORY_CONSUMER_GROUP_ID,
    });
  }

  let groupDescription;
  try {
    groupDescription = await admin.describeGroups([
      HISTORY_CONSUMER_GROUP_ID,
    ]);
  } catch {
    throw new Error("Unable to retrieve V2 history Kafka group description.");
  }
  validateGroupDescription(groupDescription);

  await verifyNoCommittedOffsets(admin);

  return Object.freeze({
    status: "existing-empty-uncommitted",
    groupId: HISTORY_CONSUMER_GROUP_ID,
    topic: HISTORY_TOPIC,
    partitionIds: PARTITION_IDS,
  });
}

async function verifyNoCommittedOffsets(admin) {
  let offsets;
  try {
    offsets = await admin.fetchOffsets({
      groupId: HISTORY_CONSUMER_GROUP_ID,
      topics: [HISTORY_TOPIC],
      resolveOffsets: false,
    });
  } catch {
    throw new Error("Unable to retrieve V2 history Kafka group offsets.");
  }
  validateUncommittedOffsets(offsets);
}

module.exports = {
  verifyHistorySmokeGroup,
};
