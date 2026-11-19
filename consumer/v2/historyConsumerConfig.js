const HISTORY_KAFKA_BROKER = "127.0.0.1:19092";
const HISTORY_KAFKA_CLUSTER_ID = "4L6g3nShT-eMCtK--X86sw";
const HISTORY_TOPIC = "crypto-prices-v2";
const HISTORY_CONSUMER_GROUP_ID = "crypto-v2-history-group";
const HISTORY_MONGO_URI =
  "mongodb://127.0.0.1:27019/crypto_analytics_v2?directConnection=true";
const HISTORY_DATABASE_NAME = "crypto_analytics_v2";
const HISTORY_REPLICA_SET_NAME = "rs-v2";
const HISTORY_MONGO_MEMBER = "v2-mongodb:27017";
const LIVE_START_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_V2_HISTORY_BACKFILL";

const BOUNDS = Object.freeze({
  mongoTimeoutMS: [1000, 60000],
  mongoConnectTimeoutMS: [250, 30000],
  mongoServerSelectionTimeoutMS: [250, 30000],
  mongoSocketTimeoutMS: [250, 60000],
  kafkaConnectionTimeoutMS: [250, 30000],
  kafkaRequestTimeoutMS: [250, 30000],
  batchSize: [1, 100],
  persistenceConcurrency: [1, 4],
  partitionsConsumedConcurrently: [1, 2],
  sessionTimeoutMs: [6000, 120000],
  heartbeatIntervalMs: [100, 30000],
  heartbeatTimeoutMs: [10, 30000],
});

function assertPinnedOverride(env, name, expected) {
  const actual = env[name];
  if (actual !== undefined && actual !== expected) {
    throw new Error(`${name} must match the pinned V2 history configuration.`);
  }
}

function readBoundedInteger(env, name, defaultValue, [minimum, maximum]) {
  const value = env[name] === undefined ? defaultValue : env[name];
  const validNumber = typeof value === "number" && Number.isInteger(value);
  const validString = typeof value === "string" && /^[0-9]+$/.test(value);
  const number = validNumber || validString ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function loadHistoryConsumerConfig(env = process.env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error("V2 history configuration requires an environment object.");
  }
  if (env.V2_HISTORY_CONSUMER_ENABLED !== "true") {
    throw new Error("V2 history consumer is disabled; explicitly enable it to start.");
  }
  if (env.V2_HISTORY_LIVE_START_ACK !== LIVE_START_ACKNOWLEDGEMENT) {
    throw new Error("V2 history live-start acknowledgement is required.");
  }

  assertPinnedOverride(env, "V2_HISTORY_KAFKA_BROKER", HISTORY_KAFKA_BROKER);
  assertPinnedOverride(env, "V2_HISTORY_KAFKA_CLUSTER_ID", HISTORY_KAFKA_CLUSTER_ID);
  assertPinnedOverride(env, "V2_HISTORY_TOPIC", HISTORY_TOPIC);
  assertPinnedOverride(env, "V2_HISTORY_CONSUMER_GROUP_ID", HISTORY_CONSUMER_GROUP_ID);
  assertPinnedOverride(env, "V2_HISTORY_MONGO_URI", HISTORY_MONGO_URI);
  assertPinnedOverride(env, "V2_HISTORY_DATABASE_NAME", HISTORY_DATABASE_NAME);

  const expectedTopicId = env.V2_HISTORY_TOPIC_ID === undefined
    ? null
    : env.V2_HISTORY_TOPIC_ID;
  if (expectedTopicId !== null &&
      (typeof expectedTopicId !== "string" ||
        !/^[A-Za-z0-9_-]{22}$/.test(expectedTopicId))) {
    throw new Error("V2_HISTORY_TOPIC_ID must be an independently established Kafka topic ID.");
  }

  const mongoOptions = Object.freeze({
    timeoutMS: readBoundedInteger(
      env,
      "V2_HISTORY_MONGO_TIMEOUT_MS",
      15000,
      BOUNDS.mongoTimeoutMS,
    ),
    connectTimeoutMS: readBoundedInteger(
      env,
      "V2_HISTORY_MONGO_CONNECT_TIMEOUT_MS",
      5000,
      BOUNDS.mongoConnectTimeoutMS,
    ),
    serverSelectionTimeoutMS: readBoundedInteger(
      env,
      "V2_HISTORY_MONGO_SERVER_SELECTION_TIMEOUT_MS",
      5000,
      BOUNDS.mongoServerSelectionTimeoutMS,
    ),
    socketTimeoutMS: readBoundedInteger(
      env,
      "V2_HISTORY_MONGO_SOCKET_TIMEOUT_MS",
      10000,
      BOUNDS.mongoSocketTimeoutMS,
    ),
  });
  const kafkaOptions = Object.freeze({
    connectionTimeout: readBoundedInteger(
      env,
      "V2_HISTORY_KAFKA_CONNECTION_TIMEOUT_MS",
      5000,
      BOUNDS.kafkaConnectionTimeoutMS,
    ),
    requestTimeout: readBoundedInteger(
      env,
      "V2_HISTORY_KAFKA_REQUEST_TIMEOUT_MS",
      10000,
      BOUNDS.kafkaRequestTimeoutMS,
    ),
  });
  const consumerOptions = Object.freeze({
    groupId: HISTORY_CONSUMER_GROUP_ID,
    sessionTimeoutMs: readBoundedInteger(
      env,
      "V2_HISTORY_SESSION_TIMEOUT_MS",
      45000,
      BOUNDS.sessionTimeoutMs,
    ),
    heartbeatIntervalMs: readBoundedInteger(
      env,
      "V2_HISTORY_HEARTBEAT_INTERVAL_MS",
      5000,
      BOUNDS.heartbeatIntervalMs,
    ),
    heartbeatTimeoutMs: readBoundedInteger(
      env,
      "V2_HISTORY_HEARTBEAT_TIMEOUT_MS",
      5000,
      BOUNDS.heartbeatTimeoutMs,
    ),
    partitionsConsumedConcurrently: readBoundedInteger(
      env,
      "V2_HISTORY_PARTITIONS_CONSUMED_CONCURRENTLY",
      1,
      BOUNDS.partitionsConsumedConcurrently,
    ),
  });
  if (consumerOptions.heartbeatIntervalMs >= consumerOptions.sessionTimeoutMs ||
      consumerOptions.heartbeatTimeoutMs >= consumerOptions.sessionTimeoutMs) {
    throw new Error(
      "V2 history heartbeat interval and timeout must be less than the session timeout.",
    );
  }
  const historyOptions = Object.freeze({
    batchSize: readBoundedInteger(
      env,
      "V2_HISTORY_BATCH_SIZE",
      25,
      BOUNDS.batchSize,
    ),
    concurrency: readBoundedInteger(
      env,
      "V2_HISTORY_PERSISTENCE_CONCURRENCY",
      2,
      BOUNDS.persistenceConcurrency,
    ),
  });

  return Object.freeze({
    enabled: true,
    liveStartAcknowledged: true,
    kafka: Object.freeze({
      broker: HISTORY_KAFKA_BROKER,
      clusterId: HISTORY_KAFKA_CLUSTER_ID,
      topic: HISTORY_TOPIC,
      topicPartitionCount: 6,
      expectedTopicId,
      options: kafkaOptions,
    }),
    consumer: consumerOptions,
    mongo: Object.freeze({
      uri: HISTORY_MONGO_URI,
      databaseName: HISTORY_DATABASE_NAME,
      replicaSetName: HISTORY_REPLICA_SET_NAME,
      member: HISTORY_MONGO_MEMBER,
      options: mongoOptions,
    }),
    history: historyOptions,
  });
}

module.exports = {
  HISTORY_CONSUMER_GROUP_ID,
  HISTORY_DATABASE_NAME,
  HISTORY_KAFKA_BROKER,
  HISTORY_KAFKA_CLUSTER_ID,
  HISTORY_MONGO_MEMBER,
  HISTORY_MONGO_URI,
  HISTORY_REPLICA_SET_NAME,
  HISTORY_TOPIC,
  LIVE_START_ACKNOWLEDGEMENT,
  loadHistoryConsumerConfig,
};
