const {
  HISTORY_DATABASE_NAME,
  HISTORY_MONGO_MEMBER,
  HISTORY_MONGO_URI,
  HISTORY_REPLICA_SET_NAME,
} = require("./historyConsumerConfig");
const { verifyHistoryMongoIdentity } = require("./historyConsumerPreflight");
const { ensureHistoryIndexes } = require("./historyIndexes");
const {
  HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
  provisionHistoryCollectionsForNamespace,
} = require("./historyCollectionProvisioningInternal");
const { HISTORY_COLLECTION_NAMES } = require("./historyCollectionInspection");

const PRODUCTION_NAMESPACE_POLICY = Object.freeze({
  kind: "production",
  databaseName: HISTORY_DATABASE_NAME,
  collections: Object.freeze({
    history: HISTORY_COLLECTION_NAMES.history,
    receipts: HISTORY_COLLECTION_NAMES.receipts,
  }),
});
const PRODUCTION_IDENTITY_CONFIG = Object.freeze({
  mongo: Object.freeze({
    uri: HISTORY_MONGO_URI,
    databaseName: HISTORY_DATABASE_NAME,
    replicaSetName: HISTORY_REPLICA_SET_NAME,
    member: HISTORY_MONGO_MEMBER,
  }),
});

async function provisionHistoryCollections({
  database,
  mongoClient,
  provisionAcknowledgement,
}) {
  if (provisionAcknowledgement !== HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT) {
    throw new Error("V2 history collection provisioning acknowledgement is required.");
  }
  return provisionHistoryCollectionsForNamespace({
    namespacePolicy: PRODUCTION_NAMESPACE_POLICY,
    database,
    mongoClient,
    provisionAcknowledgement: HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
    identityConfig: PRODUCTION_IDENTITY_CONFIG,
    verifyMongoIdentity: verifyHistoryMongoIdentity,
    ensureIndexes: ensureHistoryIndexes,
  });
}

module.exports = {
  HISTORY_COLLECTION_PROVISION_ACKNOWLEDGEMENT,
  provisionHistoryCollections,
};
