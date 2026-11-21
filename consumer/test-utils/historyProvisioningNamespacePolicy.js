const {
  getMongoTestDatabaseName,
} = require("../../test-utils/mongoIntegrationSafety");
const {
  HISTORY_COLLECTION_NAMES,
} = require("../v2/historyCollectionInspection");

function createHistoryProvisioningTestNamespacePolicy(database) {
  const databaseName = getMongoTestDatabaseName(database);
  return Object.freeze({
    kind: "disposable",
    databaseName,
    collections: Object.freeze({
      history: HISTORY_COLLECTION_NAMES.history,
      receipts: HISTORY_COLLECTION_NAMES.receipts,
    }),
  });
}

module.exports = {
  createHistoryProvisioningTestNamespacePolicy,
};
