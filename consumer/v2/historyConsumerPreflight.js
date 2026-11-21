const {
  HISTORY_CONSUMER_GROUP_ID,
  HISTORY_DATABASE_NAME,
  HISTORY_KAFKA_BROKER,
  HISTORY_KAFKA_CLUSTER_ID,
  HISTORY_MONGO_MEMBER,
  HISTORY_MONGO_URI,
  HISTORY_REPLICA_SET_NAME,
  HISTORY_TOPIC,
} = require("./historyConsumerConfig");
const { isHistorySmokeTopicIdentityResult } = require("./historySmokeTopicPreflight");

function validateConfig(config) {
  if (!config || config.enabled !== true ||
      config.liveStartAcknowledged !== true ||
      !config.kafka || !config.consumer || !config.mongo ||
      config.kafka.broker !== HISTORY_KAFKA_BROKER ||
      config.kafka.clusterId !== HISTORY_KAFKA_CLUSTER_ID ||
      config.kafka.topic !== HISTORY_TOPIC ||
      config.kafka.topicPartitionCount !== 6 ||
      config.consumer.groupId !== HISTORY_CONSUMER_GROUP_ID ||
      config.mongo.uri !== HISTORY_MONGO_URI ||
      config.mongo.databaseName !== HISTORY_DATABASE_NAME ||
      config.mongo.replicaSetName !== HISTORY_REPLICA_SET_NAME ||
      config.mongo.member !== HISTORY_MONGO_MEMBER ||
      (config.kafka.expectedTopicId !== null &&
        (typeof config.kafka.expectedTopicId !== "string" ||
          !/^[A-Za-z0-9_-]{22}$/.test(config.kafka.expectedTopicId)))) {
    throw new Error("Invalid pinned V2 history identity configuration.");
  }
}

function validateMongoIdentityConfig(config) {
  const mongo = config && config.mongo;
  if (!mongo ||
      mongo.uri !== HISTORY_MONGO_URI ||
      mongo.databaseName !== HISTORY_DATABASE_NAME ||
      mongo.replicaSetName !== HISTORY_REPLICA_SET_NAME ||
      mongo.member !== HISTORY_MONGO_MEMBER) {
    throw new Error("Invalid pinned V2 history MongoDB identity configuration.");
  }
}

function validateKafkaAdmin(admin) {
  if (!admin || typeof admin.describeCluster !== "function" ||
      typeof admin.fetchTopicMetadata !== "function") {
    throw new Error("Invalid Kafka admin dependency for V2 history preflight.");
  }
}

async function verifyHistoryKafkaIdentity({ admin, config, verifySmokeTopicIdentity }) {
  validateConfig(config);
  validateKafkaAdmin(admin);

  let clusterMetadata;
  try {
    clusterMetadata = await admin.describeCluster();
  } catch {
    throw new Error("Unable to retrieve V2 history Kafka cluster identity.");
  }
  if (!clusterMetadata || clusterMetadata.clusterId !== config.kafka.clusterId) {
    throw new Error("V2 history Kafka cluster identity does not match the pinned cluster.");
  }

  let metadata;
  try {
    metadata = await admin.fetchTopicMetadata({ topics: [config.kafka.topic] });
  } catch {
    throw new Error("Unable to retrieve V2 history Kafka topic metadata.");
  }

  const topics = metadata && metadata.topics;
  if (!Array.isArray(topics) || topics.length !== 1 ||
      !topics[0] || topics[0].name !== config.kafka.topic ||
      !Array.isArray(topics[0].partitions) ||
      (topics[0].topicErrorCode !== undefined && topics[0].topicErrorCode !== 0)) {
    throw new Error("V2 history Kafka topic metadata is missing or unexpected.");
  }

  const topic = topics[0];
  const partitions = topic.partitions;
  const partitionIds = partitions.map((partition) =>
    partition && partition.partitionId);
  if (partitions.length !== config.kafka.topicPartitionCount ||
      partitionIds.some((id) => !Number.isInteger(id)) ||
      new Set(partitionIds).size !== config.kafka.topicPartitionCount ||
      [0, 1, 2, 3, 4, 5].some((id) => !partitionIds.includes(id)) ||
      partitions.some((partition) =>
        partition.partitionErrorCode !== 0 ||
        !Number.isInteger(partition.leader) ||
        partition.leader < 0)) {
    throw new Error("V2 history Kafka topic must have six healthy partitions numbered 0 through 5.");
  }

  if (config.kafka.expectedTopicId !== null) {
    if (topic.topicId === undefined &&
        config.firstRunSmoke && config.firstRunSmoke.enabled === true &&
        typeof verifySmokeTopicIdentity === "function") {
      let smokeIdentity;
      try {
        smokeIdentity = await verifySmokeTopicIdentity();
      } catch {
        throw new Error("Unable to verify V2 history smoke Kafka topic identity.");
      }
      if (!isHistorySmokeTopicIdentityResult(smokeIdentity, config)) {
        throw new Error("V2 history smoke Kafka topic identity is invalid.");
      }
    } else if (typeof topic.topicId !== "string" ||
        topic.topicId !== config.kafka.expectedTopicId) {
      throw new Error("V2 history Kafka topic ID is missing or does not match the pinned ID.");
    }
  }

  return Object.freeze({
    clusterId: clusterMetadata.clusterId,
    topic: config.kafka.topic,
    partitionIds: Object.freeze([0, 1, 2, 3, 4, 5]),
    topicIdVerified: config.kafka.expectedTopicId !== null,
  });
}

function resolveAdminDatabase({ mongoClient, adminDatabase }) {
  if (adminDatabase && typeof adminDatabase.command === "function") {
    return adminDatabase;
  }
  if (!mongoClient || typeof mongoClient.db !== "function") {
    throw new Error("A MongoDB client or admin database is required for V2 history preflight.");
  }
  try {
    const database = mongoClient.db("admin");
    if (!database || typeof database.command !== "function") {
      throw new Error("invalid database");
    }
    return database;
  } catch {
    throw new Error("Unable to access the MongoDB admin database for V2 history preflight.");
  }
}

async function verifyHistoryMongoIdentity({ mongoClient, adminDatabase, config }) {
  validateMongoIdentityConfig(config);
  const database = resolveAdminDatabase({ mongoClient, adminDatabase });

  let hello;
  try {
    hello = await database.command({ hello: 1 });
  } catch {
    throw new Error("Unable to retrieve V2 history MongoDB primary identity.");
  }
  if (!hello ||
      hello.setName !== config.mongo.replicaSetName ||
      hello.isWritablePrimary !== true ||
      hello.me !== config.mongo.member) {
    throw new Error("V2 history MongoDB replica set or writable-primary identity does not match.");
  }

  let status;
  try {
    status = await database.command({ replSetGetStatus: 1 });
  } catch {
    throw new Error("Unable to retrieve V2 history MongoDB replica-set status.");
  }
  const members = status && status.members;
  if (!status || status.set !== config.mongo.replicaSetName ||
      !Array.isArray(members) || members.length !== 1 ||
      !members[0] || members[0].name !== config.mongo.member ||
      members[0].stateStr !== "PRIMARY" ||
      members[0].self !== true) {
    throw new Error("V2 history MongoDB replica-set member identity does not match.");
  }

  return Object.freeze({
    replicaSetName: status.set,
    member: config.mongo.member,
    isWritablePrimary: true,
  });
}

async function verifyHistoryConsumerPreflights({
  admin,
  mongoClient,
  adminDatabase,
  config,
  verifySmokeTopicIdentity,
}) {
  validateConfig(config);
  const kafka = await verifyHistoryKafkaIdentity({ admin, config, verifySmokeTopicIdentity });
  const mongo = await verifyHistoryMongoIdentity({
    mongoClient,
    adminDatabase,
    config,
  });
  return Object.freeze({ kafka, mongo });
}

module.exports = {
  verifyHistoryConsumerPreflights,
  verifyHistoryKafkaIdentity,
  verifyHistoryMongoIdentity,
};
