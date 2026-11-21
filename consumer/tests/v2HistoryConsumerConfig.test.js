const {
  HISTORY_CONSUMER_GROUP_ID,
  HISTORY_DATABASE_NAME,
  FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
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

const smokeEnvironment = {
  ...enabledEnvironment,
  V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
  V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: "10",
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "60000",
  V2_HISTORY_TOPIC_ID: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
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
  expect(config).not.toHaveProperty("firstRunSmoke");
  expect(config.kafka.options.connectionTimeout).toBe(5000);
  expect(config.kafka.options.requestTimeout).toBe(10000);
  expect(config).not.toHaveProperty("history.historyCollectionName");
  expect(config).not.toHaveProperty("history.receiptCollectionName");
});

test("loads separately authorized smoke limits and configured topic identity", () => {
  expect(loadHistoryConsumerConfig(smokeEnvironment)).toMatchObject({
    enabled: true,
    liveStartAcknowledged: true,
    firstRunSmoke: {
      enabled: true,
      maxRecords: 10,
      maxRuntimeMs: 60000,
    },
    kafka: {
      expectedTopicId: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
    },
  });
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
  [{ V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "yes" }, "must be true or false"],
  [{
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
    V2_HISTORY_FIRST_RUN_SMOKE_ACK: "yes",
  }, "acknowledgement is required"],
  [{
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
    V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "60000",
    V2_HISTORY_TOPIC_ID: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  }, "V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS must be an integer"],
  [{
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
    V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: "10",
    V2_HISTORY_TOPIC_ID: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  }, "V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS must be an integer"],
  [{
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
    V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: "10",
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "60000",
  }, "configured first-run smoke topic identity"],
  [{
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
    V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: "10",
    V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "60000",
    V2_HISTORY_TOPIC_ID: "abcdefghijklmnopqrstuv",
  }, "configured first-run smoke topic identity"],
])("rejects incomplete or contradictory smoke configuration", (smokeEnv, message) => {
  expect(() => loadHistoryConsumerConfig({
    ...enabledEnvironment,
    ...smokeEnv,
  })).toThrow(message);
});

test.each([
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS", "0"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS", "101"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS", "1.5"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS", "nope"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS", "999"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS", "300001"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS", "1.5"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS", "nope"],
])("rejects an invalid smoke bound for %s", (name, value) => {
  expect(() => loadHistoryConsumerConfig({
    ...smokeEnvironment,
    [name]: value,
  })).toThrow(`${name} must be an integer`);
});

test.each([
  ["V2_HISTORY_FIRST_RUN_SMOKE_ACK", FIRST_RUN_SMOKE_ACKNOWLEDGEMENT],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS", "10"],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS", "60000"],
])("rejects smoke settings without selecting smoke mode: %s", (name, value) => {
  expect(() => loadHistoryConsumerConfig({
    ...enabledEnvironment,
    [name]: value,
  })).toThrow("require V2_HISTORY_FIRST_RUN_SMOKE_ENABLED=true");
});

test("explicitly disabling smoke mode preserves normal configuration", () => {
  expect(loadHistoryConsumerConfig({
    ...enabledEnvironment,
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "false",
  })).not.toHaveProperty("firstRunSmoke");
  expect(() => loadHistoryConsumerConfig({
    ...enabledEnvironment,
    V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "false",
    V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  })).toThrow("require V2_HISTORY_FIRST_RUN_SMOKE_ENABLED=true");
});

test.each([
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS", "1", 1],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS", "100", 100],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS", "1000", 1000],
  ["V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS", "300000", 300000],
])("accepts inclusive smoke bound %s=%s", (name, value, expected) => {
  expect(loadHistoryConsumerConfig({
    ...smokeEnvironment,
    [name]: value,
  }).firstRunSmoke[name.endsWith("MAX_RECORDS") ? "maxRecords" : "maxRuntimeMs"])
    .toBe(expected);
});

test("smoke authorization does not bypass normal consumer authorization", () => {
  expect(() => loadHistoryConsumerConfig({
    ...smokeEnvironment,
    V2_HISTORY_CONSUMER_ENABLED: "false",
  })).toThrow("explicitly enable");
  expect(() => loadHistoryConsumerConfig({
    ...smokeEnvironment,
    V2_HISTORY_LIVE_START_ACK: "incorrect",
  })).toThrow("live-start acknowledgement is required");
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

test("loading smoke configuration has no startup side effects or input mutation", () => {
  const env = { ...smokeEnvironment };
  const originalEnv = { ...env };
  const processOn = jest.spyOn(process, "on");
  try {
    jest.isolateModules(() => {
      const { loadHistoryConsumerConfig: loadIsolatedConfig } =
        require("../v2/historyConsumerConfig");
      expect(loadIsolatedConfig(env).firstRunSmoke.enabled).toBe(true);
    });

    expect(env).toEqual(originalEnv);
    expect(processOn).not.toHaveBeenCalled();
    expect(loadHistoryConsumerConfig(env)).not.toHaveProperty("provisioning");
  } finally {
    processOn.mockRestore();
  }
});
