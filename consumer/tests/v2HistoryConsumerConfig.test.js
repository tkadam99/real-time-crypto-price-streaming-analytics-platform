const {
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
} = require("../v2/historyConsumerConfig");

const enabledEnvironment = {
  V2_HISTORY_CONSUMER_ENABLED: "true",
  V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
};

test("loads pinned V2 identities and bounded defaults only after both acknowledgements", () => {
  const config = loadHistoryConsumerConfig(enabledEnvironment);

  expect(config).toMatchObject({
    enabled: true,
    liveStartAcknowledged: true,
    kafka: {
      broker: HISTORY_KAFKA_BROKER,
      clusterId: HISTORY_KAFKA_CLUSTER_ID,
      topic: HISTORY_TOPIC,
      topicPartitionCount: 6,
      expectedTopicId: null,
    },
    consumer: {
      groupId: HISTORY_CONSUMER_GROUP_ID,
      sessionTimeoutMs: 45000,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 5000,
      partitionsConsumedConcurrently: 1,
    },
    mongo: {
      uri: HISTORY_MONGO_URI,
      databaseName: HISTORY_DATABASE_NAME,
      replicaSetName: HISTORY_REPLICA_SET_NAME,
      member: HISTORY_MONGO_MEMBER,
      options: {
        timeoutMS: 15000,
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 10000,
      },
    },
    history: {
      batchSize: 25,
      concurrency: 2,
    },
  });
  expect(config.kafka.options.connectionTimeout).toBe(5000);
  expect(config.kafka.options.requestTimeout).toBe(10000);
  expect(config).not.toHaveProperty("history.historyCollectionName");
  expect(config).not.toHaveProperty("history.receiptCollectionName");
});

test.each([
  [{ V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT }, "explicitly enable"],
  [{ ...enabledEnvironment, V2_HISTORY_CONSUMER_ENABLED: "false" }, "explicitly enable"],
  [{ V2_HISTORY_CONSUMER_ENABLED: "true" }, "acknowledgement is required"],
  [{
    ...enabledEnvironment,
    V2_HISTORY_LIVE_START_ACK: "yes",
  }, "acknowledgement is required"],
])("fails closed for missing enablement or live-start acknowledgement", (env, message) => {
  expect(() => loadHistoryConsumerConfig(env)).toThrow(message);
});

test.each([
  ["V2_HISTORY_KAFKA_BROKER", "10.0.0.1:19092"],
  ["V2_HISTORY_KAFKA_CLUSTER_ID", "wrong-cluster"],
  ["V2_HISTORY_TOPIC", "crypto-prices"],
  ["V2_HISTORY_CONSUMER_GROUP_ID", "crypto-v2-relay-group"],
  ["V2_HISTORY_MONGO_URI", "mongodb://localhost:27017/crypto_analytics"],
  ["V2_HISTORY_DATABASE_NAME", "crypto_analytics"],
])("rejects a mismatched pinned override for %s without echoing it", (name, value) => {
  let error;
  try {
    loadHistoryConsumerConfig({
      ...enabledEnvironment,
      [name]: value,
    });
  } catch (caught) {
    error = caught;
  }

  expect(error.message).toContain(name);
  expect(error.message).not.toContain(value);
});

test("accepts only an independently supplied Kafka topic ID and does not invent one", () => {
  const expectedTopicId = "abcdefghijklmnopqrstuv";
  expect(loadHistoryConsumerConfig({
    ...enabledEnvironment,
    V2_HISTORY_TOPIC_ID: expectedTopicId,
  }).kafka.expectedTopicId).toBe(expectedTopicId);
  expect(() => loadHistoryConsumerConfig({
    ...enabledEnvironment,
    V2_HISTORY_TOPIC_ID: "invented",
  })).toThrow("independently established Kafka topic ID");
});

test.each([
  ["V2_HISTORY_MONGO_TIMEOUT_MS", "999"],
  ["V2_HISTORY_MONGO_CONNECT_TIMEOUT_MS", "30001"],
  ["V2_HISTORY_MONGO_SERVER_SELECTION_TIMEOUT_MS", "nope"],
  ["V2_HISTORY_MONGO_SOCKET_TIMEOUT_MS", "60001"],
  ["V2_HISTORY_KAFKA_CONNECTION_TIMEOUT_MS", "249"],
  ["V2_HISTORY_KAFKA_REQUEST_TIMEOUT_MS", "30001"],
  ["V2_HISTORY_BATCH_SIZE", "101"],
  ["V2_HISTORY_PERSISTENCE_CONCURRENCY", "0"],
  ["V2_HISTORY_PARTITIONS_CONSUMED_CONCURRENTLY", "3"],
  ["V2_HISTORY_SESSION_TIMEOUT_MS", "5999"],
  ["V2_HISTORY_HEARTBEAT_INTERVAL_MS", "30001"],
  ["V2_HISTORY_HEARTBEAT_TIMEOUT_MS", "9"],
])("rejects an out-of-bounds value for %s", (name, value) => {
  expect(() => loadHistoryConsumerConfig({
    ...enabledEnvironment,
    [name]: value,
  })).toThrow(`${name} must be an integer`);
});

test("rejects heartbeat interval or timeout values that exceed the consumer session timeout", () => {
  expect(() => loadHistoryConsumerConfig({
    ...enabledEnvironment,
    V2_HISTORY_SESSION_TIMEOUT_MS: "6000",
    V2_HISTORY_HEARTBEAT_INTERVAL_MS: "6000",
  })).toThrow("heartbeat interval and timeout must be less than the session timeout");
  expect(() => loadHistoryConsumerConfig({
    ...enabledEnvironment,
    V2_HISTORY_SESSION_TIMEOUT_MS: "6000",
    V2_HISTORY_HEARTBEAT_TIMEOUT_MS: "6000",
  })).toThrow("heartbeat interval and timeout must be less than the session timeout");
});

test("does not accept a missing or malformed environment object", () => {
  expect(() => loadHistoryConsumerConfig(null)).toThrow("environment object");
});
