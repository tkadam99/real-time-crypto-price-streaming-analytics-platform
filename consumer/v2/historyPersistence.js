const { createHistoryDocuments } = require("./historyContract");

function isExactIdDuplicate(error, eventIdentity) {
  if (!error || error.code !== 11000) return false;

  const pattern = error.keyPattern;
  const value = error.keyValue;
  const patternKeys = pattern && typeof pattern === "object" ? Object.keys(pattern) : [];
  const valueKeys = value && typeof value === "object" ? Object.keys(value) : [];
  const exactIdPattern = patternKeys.length === 1 &&
    patternKeys[0] === "_id" && pattern._id === 1;
  const exactIdValue = valueKeys.length === 1 &&
    valueKeys[0] === "_id" && value._id === eventIdentity;

  if (patternKeys.length > 0) {
    return exactIdPattern && (valueKeys.length === 0 || exactIdValue);
  }
  return exactIdValue;
}

function validateDependencies({ client, historyCollection, receiptCollection }) {
  if (!client || typeof client.startSession !== "function") {
    throw new Error("A MongoDB client with startSession() is required.");
  }
  if (!historyCollection || typeof historyCollection.insertOne !== "function") {
    throw new Error("A history collection with insertOne() is required.");
  }
  if (!receiptCollection || typeof receiptCollection.findOne !== "function" ||
      typeof receiptCollection.insertOne !== "function") {
    throw new Error("A receipt collection with findOne() and insertOne() is required.");
  }
}

async function persistHistoryEvent({
  client,
  historyCollection,
  receiptCollection,
  envelope,
  insertedAt = new Date(),
}) {
  validateDependencies({ client, historyCollection, receiptCollection });
  const { history, receipt } = createHistoryDocuments(envelope, insertedAt);
  const session = client.startSession();
  if (!session || typeof session.withTransaction !== "function" ||
      typeof session.endSession !== "function") {
    throw new Error("MongoDB client returned an invalid session.");
  }

  try {
    return await session.withTransaction(async () => {
      const existingReceipt = await receiptCollection.findOne(
        { _id: receipt._id },
        { session },
      );
      if (existingReceipt !== null && existingReceipt !== undefined) {
        return { status: "replay", eventIdentity: receipt._id };
      }

      await receiptCollection.insertOne(receipt, { session });
      await historyCollection.insertOne(history, { session });
      return { status: "inserted", eventIdentity: receipt._id };
    });
  } catch (error) {
    if (!isExactIdDuplicate(error, receipt._id)) throw error;

    const durableReceipt = await receiptCollection.findOne({ _id: receipt._id });
    if (durableReceipt === null || durableReceipt === undefined) throw error;
    return { status: "replay", eventIdentity: receipt._id };
  } finally {
    await session.endSession();
  }
}

module.exports = {
  isExactIdDuplicate,
  persistHistoryEvent,
};
