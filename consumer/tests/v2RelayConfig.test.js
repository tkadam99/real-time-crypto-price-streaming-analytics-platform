const { loadRelayConfig } = require("../v2/relayConfig");

const sourceEnvironment = {
  V1_SOURCE_CLUSTER_ID: "0jtOiYT4QmShqPK0HjBpQA",
  V1_SOURCE_TOPIC_GENERATION_ID: "9ShfnW90Th-vI4A2Jl1O4Q",
};

test("loads the Windows-host relay defaults and stable source identities", () => {
  expect(loadRelayConfig(sourceEnvironment)).toEqual({
    v1KafkaBroker: "127.0.0.1:9092",
    v2KafkaBroker: "127.0.0.1:19092",
    v1Topic: "crypto-prices",
    v2Topic: "crypto-prices-v2",
    consumerGroupId: "crypto-v2-relay-group",
    v2PartitionCount: 6,
    sourceIdentity: {
      clusterId: "0jtOiYT4QmShqPK0HjBpQA",
      topicGenerationId: "9ShfnW90Th-vI4A2Jl1O4Q",
    },
  });
});

test("accepts non-empty broker overrides without changing relay identity", () => {
  const config = loadRelayConfig({
    ...sourceEnvironment,
    V1_KAFKA_BROKER: "v1-host:9092",
    V2_KAFKA_BROKER: "v2-host:19092",
  });

  expect(config.v1KafkaBroker).toBe("v1-host:9092");
  expect(config.v2KafkaBroker).toBe("v2-host:19092");
  expect(config.sourceIdentity).toEqual({
    clusterId: sourceEnvironment.V1_SOURCE_CLUSTER_ID,
    topicGenerationId: sourceEnvironment.V1_SOURCE_TOPIC_GENERATION_ID,
  });
});

test.each([
  ["V1_SOURCE_CLUSTER_ID", undefined],
  ["V1_SOURCE_CLUSTER_ID", ""],
  ["V1_SOURCE_CLUSTER_ID", "wrong-cluster"],
  ["V1_SOURCE_TOPIC_GENERATION_ID", undefined],
  ["V1_SOURCE_TOPIC_GENERATION_ID", ""],
  ["V1_SOURCE_TOPIC_GENERATION_ID", "wrong-generation"],
])("rejects a missing or invalid %s without echoing its value", (name, value) => {
  const env = { ...sourceEnvironment };
  if (value !== undefined) env[name] = value;
  else delete env[name];

  let error;
  try {
    loadRelayConfig(env);
  } catch (caught) {
    error = caught;
  }
  expect(error.message).toContain(name);
  expect(error.message).not.toContain("wrong-");
});

test.each(["", "5", "7", "6.0", "six", 5, 7])(
  "rejects invalid V2 partition count %p",
  (partitionCount) => {
    expect(() => loadRelayConfig({
      ...sourceEnvironment,
      V2_KAFKA_PARTITION_COUNT: partitionCount,
    })).toThrow("V2_KAFKA_PARTITION_COUNT must be exactly 6.");
  },
);

test.each(["V1_KAFKA_BROKER", "V2_KAFKA_BROKER"])(
  "rejects an empty %s",
  (name) => {
    expect(() => loadRelayConfig({
      ...sourceEnvironment,
      [name]: "  ",
    })).toThrow(`${name} must be a non-empty broker address.`);
  },
);

test.each(["crypto-analytics-group", "crypto-current-price-group"])(
  "rejects reuse of V1 consumer group %s",
  (consumerGroupId) => {
    expect(() => loadRelayConfig({
      ...sourceEnvironment,
      V2_RELAY_CONSUMER_GROUP_ID: consumerGroupId,
    })).toThrow("must not reuse a V1 consumer group");
  },
);

test("rejects any non-dedicated relay group and invalid environment input", () => {
  expect(() => loadRelayConfig({
    ...sourceEnvironment,
    V2_RELAY_CONSUMER_GROUP_ID: "another-group",
  })).toThrow("V2_RELAY_CONSUMER_GROUP_ID must be crypto-v2-relay-group.");
  expect(() => loadRelayConfig(null)).toThrow("environment object");
});
