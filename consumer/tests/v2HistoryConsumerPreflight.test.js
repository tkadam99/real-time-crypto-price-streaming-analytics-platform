const {
  HISTORY_KAFKA_CLUSTER_ID,
  HISTORY_TOPIC,
  LIVE_START_ACKNOWLEDGEMENT,
  loadHistoryConsumerConfig,
} = require("../v2/historyConsumerConfig");
const {
  verifyHistoryConsumerPreflights,
  verifyHistoryKafkaIdentity,
  verifyHistoryMongoIdentity,
} = require("../v2/historyConsumerPreflight");

const config = loadHistoryConsumerConfig({
  V2_HISTORY_CONSUMER_ENABLED: "true",
  V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
});
const topicId = "abcdefghijklmnopqrstuv";

function topicMetadata({
  name = HISTORY_TOPIC,
  topicErrorCode,
  partitionOverrides = {},
  topicId: id,
} = {}) {
  return {
    topics: [{
      name,
      ...(topicErrorCode === undefined ? {} : { topicErrorCode }),
      ...(id === undefined ? {} : { topicId: id }),
      partitions: [0, 1, 2, 3, 4, 5].map((partitionId) => ({
        partitionId,
        leader: 1,
        partitionErrorCode: 0,
        ...partitionOverrides[partitionId],
      })),
    }],
  };
}

function createKafkaAdmin({
  clusterId = HISTORY_KAFKA_CLUSTER_ID,
  metadata = topicMetadata(),
  describeError,
  metadataError,
  events = [],
} = {}) {
  return {
    describeCluster: jest.fn(async () => {
      events.push("kafka.describeCluster");
      if (describeError) throw describeError;
      return { clusterId };
    }),
    fetchTopicMetadata: jest.fn(async (request) => {
      events.push("kafka.fetchTopicMetadata");
      if (metadataError) throw metadataError;
      expect(request).toEqual({ topics: [HISTORY_TOPIC] });
      return metadata;
    }),
  };
}

function mongoIdentity({
  hello = {
    setName: "rs-v2",
    isWritablePrimary: true,
    me: "v2-mongodb:27017",
  },
  status = {
    set: "rs-v2",
    members: [{
      name: "v2-mongodb:27017",
      stateStr: "PRIMARY",
      self: true,
    }],
  },
  commandError,
  events = [],
} = {}) {
  const adminDatabase = {
    command: jest.fn(async (command) => {
      if (command.hello === 1) {
        events.push("mongo.hello");
        if (commandError === "hello") throw new Error("mongodb://user:secret@host");
        return hello;
      }
      events.push("mongo.replSetGetStatus");
      if (commandError === "status") throw new Error("password=secret");
      return status;
    }),
  };
  const mongoClient = {
    db: jest.fn((name) => {
      events.push(`mongo.db:${name}`);
      return adminDatabase;
    }),
  };
  return { adminDatabase, mongoClient };
}

test("verifies Kafka then MongoDB identity with injected dependencies only", async () => {
  const events = [];
  const admin = createKafkaAdmin({ events });
  const { mongoClient } = mongoIdentity({ events });

  await expect(verifyHistoryConsumerPreflights({
    admin,
    mongoClient,
    config,
  })).resolves.toEqual({
    kafka: {
      clusterId: HISTORY_KAFKA_CLUSTER_ID,
      topic: HISTORY_TOPIC,
      partitionIds: [0, 1, 2, 3, 4, 5],
      topicIdVerified: false,
    },
    mongo: {
      replicaSetName: "rs-v2",
      member: "v2-mongodb:27017",
      isWritablePrimary: true,
    },
  });

  expect(events).toEqual([
    "kafka.describeCluster",
    "kafka.fetchTopicMetadata",
    "mongo.db:admin",
    "mongo.hello",
    "mongo.replSetGetStatus",
  ]);
  expect(mongoClient.db).toHaveBeenCalledWith("admin");
});

test("fails before any identity calls when preflight config is disabled or not pinned", async () => {
  const admin = createKafkaAdmin();
  const { mongoClient } = mongoIdentity();

  await expect(verifyHistoryConsumerPreflights({
    admin,
    mongoClient,
    config: { ...config, enabled: false },
  })).rejects.toThrow("Invalid pinned V2 history identity configuration.");
  expect(admin.describeCluster).not.toHaveBeenCalled();
  expect(mongoClient.db).not.toHaveBeenCalled();
});

test("rejects Kafka cluster identity mismatches and sanitizes admin errors", async () => {
  const mismatchAdmin = createKafkaAdmin({ clusterId: "wrong-cluster" });
  await expect(verifyHistoryKafkaIdentity({
    admin: mismatchAdmin,
    config,
  })).rejects.toThrow("does not match the pinned cluster");
  expect(mismatchAdmin.fetchTopicMetadata).not.toHaveBeenCalled();

  const failingAdmin = createKafkaAdmin({
    describeError: new Error("password=secret kafka://private-host"),
  });
  let error;
  try {
    await verifyHistoryKafkaIdentity({ admin: failingAdmin, config });
  } catch (caught) {
    error = caught;
  }
  expect(error.message).toBe("Unable to retrieve V2 history Kafka cluster identity.");
  expect(error.message).not.toContain("secret");
  expect(error.message).not.toContain("private-host");
});

test("rejects Kafka metadata failures without exposing the underlying error", async () => {
  const admin = createKafkaAdmin({
    metadataError: new Error("password=secret broker=private"),
  });

  await expect(verifyHistoryKafkaIdentity({ admin, config }))
    .rejects.toThrow("Unable to retrieve V2 history Kafka topic metadata.");
});

test.each([
  [
    "unexpected topic name",
    topicMetadata({ name: "crypto-prices" }),
    "V2 history Kafka topic metadata is missing or unexpected.",
  ],
  [
    "topic metadata error",
    topicMetadata({ topicErrorCode: 3 }),
    "V2 history Kafka topic metadata is missing or unexpected.",
  ],
  [
    "missing partition",
    {
      topics: [{
        name: HISTORY_TOPIC,
        partitions: topicMetadata().topics[0].partitions.slice(0, 5),
      }],
    },
    "six healthy partitions numbered 0 through 5",
  ],
  [
    "duplicate partition ID",
    topicMetadata({ partitionOverrides: { 5: { partitionId: 4 } } }),
    "six healthy partitions numbered 0 through 5",
  ],
  [
    "unexpected partition ID",
    topicMetadata({ partitionOverrides: { 5: { partitionId: 6 } } }),
    "six healthy partitions numbered 0 through 5",
  ],
  [
    "partition metadata error",
    topicMetadata({ partitionOverrides: { 4: { partitionErrorCode: 5 } } }),
    "six healthy partitions numbered 0 through 5",
  ],
  [
    "unavailable partition leader",
    topicMetadata({ partitionOverrides: { 2: { leader: -1 } } }),
    "six healthy partitions numbered 0 through 5",
  ],
])("rejects %s", async (_label, metadata, expectedMessage) => {
  const admin = createKafkaAdmin({ metadata });
  await expect(verifyHistoryKafkaIdentity({ admin, config }))
    .rejects.toThrow(expectedMessage);
});

test("verifies a topic ID only when an independently provided expected ID is available", async () => {
  const pinnedConfig = loadHistoryConsumerConfig({
    V2_HISTORY_CONSUMER_ENABLED: "true",
    V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
    V2_HISTORY_TOPIC_ID: topicId,
  });

  await expect(verifyHistoryKafkaIdentity({
    admin: createKafkaAdmin({ metadata: topicMetadata({ topicId }) }),
    config: pinnedConfig,
  })).resolves.toMatchObject({ topicIdVerified: true });

  await expect(verifyHistoryKafkaIdentity({
    admin: createKafkaAdmin({ metadata: topicMetadata() }),
    config: pinnedConfig,
  })).rejects.toThrow("topic ID is missing or does not match");

  await expect(verifyHistoryKafkaIdentity({
    admin: createKafkaAdmin({ metadata: topicMetadata({ topicId: "zyxwvutsrqponmlkjihgfe" }) }),
    config: pinnedConfig,
  })).rejects.toThrow("topic ID is missing or does not match");
});

test.each([
  ["wrong set name", { setName: "rs-v1" }],
  ["not writable primary", { isWritablePrimary: false }],
  ["wrong advertised member", { me: "mongo:27017" }],
])("rejects MongoDB hello with %s", async (_label, helloOverride) => {
  const { mongoClient } = mongoIdentity({
    hello: {
      setName: "rs-v2",
      isWritablePrimary: true,
      me: "v2-mongodb:27017",
      ...helloOverride,
    },
  });

  await expect(verifyHistoryMongoIdentity({ mongoClient, config }))
    .rejects.toThrow("replica set or writable-primary identity does not match");
});

test.each([
  ["wrong replica-set status name", { set: "rs-v1" }],
  ["unexpected extra member", {
    members: [
      { name: "v2-mongodb:27017", stateStr: "PRIMARY", self: true },
      { name: "another:27017", stateStr: "SECONDARY", self: false },
    ],
  }],
  ["not primary", {
    members: [{ name: "v2-mongodb:27017", stateStr: "SECONDARY", self: true }],
  }],
  ["wrong member identity", {
    members: [{ name: "mongo:27017", stateStr: "PRIMARY", self: true }],
  }],
])("rejects MongoDB replica-set status with %s", async (_label, statusOverride) => {
  const { mongoClient } = mongoIdentity({
    status: {
      set: "rs-v2",
      members: [{
        name: "v2-mongodb:27017",
        stateStr: "PRIMARY",
        self: true,
      }],
      ...statusOverride,
    },
  });

  await expect(verifyHistoryMongoIdentity({ mongoClient, config }))
    .rejects.toThrow("replica-set member identity does not match");
});

test("sanitizes MongoDB command failures and accepts an injected admin database", async () => {
  const failing = mongoIdentity({ commandError: "hello" });
  let error;
  try {
    await verifyHistoryMongoIdentity({ mongoClient: failing.mongoClient, config });
  } catch (caught) {
    error = caught;
  }
  expect(error.message).toBe("Unable to retrieve V2 history MongoDB primary identity.");
  expect(error.message).not.toContain("mongodb://");
  expect(error.message).not.toContain("secret");

  const { adminDatabase } = mongoIdentity();
  await expect(verifyHistoryMongoIdentity({ adminDatabase, config }))
    .resolves.toMatchObject({
      replicaSetName: "rs-v2",
      member: "v2-mongodb:27017",
      isWritablePrimary: true,
    });
});
