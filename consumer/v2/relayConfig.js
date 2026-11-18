const {
  V1_TOPIC,
  V2_TOPIC,
  RELAY_CONSUMER_GROUP_ID,
} = require("./relayRunner");

const SOURCE_CLUSTER_ID = "0jtOiYT4QmShqPK0HjBpQA";
const SOURCE_TOPIC_GENERATION_ID = "9ShfnW90Th-vI4A2Jl1O4Q";
const V1_CONSUMER_GROUPS = new Set([
  "crypto-analytics-group",
  "crypto-current-price-group",
]);
const DEFAULT_V2_PARTITION_COUNT = 6;

function readBroker(env, name, defaultValue) {
  const value = env[name] === undefined ? defaultValue : env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty broker address.`);
  }
  return value.trim();
}

function loadRelayConfig(env) {
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("Relay configuration requires an environment object.");
  }

  if (env.V1_SOURCE_CLUSTER_ID !== SOURCE_CLUSTER_ID) {
    throw new Error("V1_SOURCE_CLUSTER_ID is missing or does not match the expected source cluster.");
  }
  if (env.V1_SOURCE_TOPIC_GENERATION_ID !== SOURCE_TOPIC_GENERATION_ID) {
    throw new Error("V1_SOURCE_TOPIC_GENERATION_ID is missing or does not match the expected topic generation.");
  }

  const partitionValue = env.V2_KAFKA_PARTITION_COUNT === undefined
    ? DEFAULT_V2_PARTITION_COUNT
    : env.V2_KAFKA_PARTITION_COUNT;
  if (typeof partitionValue !== "number" && typeof partitionValue !== "string") {
    throw new Error("V2_KAFKA_PARTITION_COUNT must be exactly 6.");
  }
  if (typeof partitionValue === "string" && !/^[0-9]+$/.test(partitionValue)) {
    throw new Error("V2_KAFKA_PARTITION_COUNT must be exactly 6.");
  }
  if (Number(partitionValue) !== DEFAULT_V2_PARTITION_COUNT) {
    throw new Error("V2_KAFKA_PARTITION_COUNT must be exactly 6.");
  }

  const consumerGroupId = env.V2_RELAY_CONSUMER_GROUP_ID === undefined
    ? RELAY_CONSUMER_GROUP_ID
    : env.V2_RELAY_CONSUMER_GROUP_ID;
  if (typeof consumerGroupId !== "string" || consumerGroupId.trim() === "") {
    throw new Error("V2_RELAY_CONSUMER_GROUP_ID must be non-empty.");
  }
  if (V1_CONSUMER_GROUPS.has(consumerGroupId)) {
    throw new Error("Relay consumer group must not reuse a V1 consumer group.");
  }
  if (consumerGroupId !== RELAY_CONSUMER_GROUP_ID) {
    throw new Error(`V2_RELAY_CONSUMER_GROUP_ID must be ${RELAY_CONSUMER_GROUP_ID}.`);
  }

  return {
    v1KafkaBroker: readBroker(env, "V1_KAFKA_BROKER", "127.0.0.1:9092"),
    v2KafkaBroker: readBroker(env, "V2_KAFKA_BROKER", "127.0.0.1:19092"),
    v1Topic: V1_TOPIC,
    v2Topic: V2_TOPIC,
    consumerGroupId,
    v2PartitionCount: DEFAULT_V2_PARTITION_COUNT,
    sourceIdentity: {
      clusterId: SOURCE_CLUSTER_ID,
      topicGenerationId: SOURCE_TOPIC_GENERATION_ID,
    },
  };
}

module.exports = { loadRelayConfig };
