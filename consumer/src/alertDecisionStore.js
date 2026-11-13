const { Long } = require("mongodb");

function eventIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("Invalid Kafka event identity.");
  }
  const { topic, partition, offset } = identity;
  if (
    typeof topic !== "string" ||
    topic.trim().length === 0 ||
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 2147483647 ||
    typeof offset !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(offset) ||
    BigInt(offset) > 9223372036854775807n
  ) {
    throw new Error("Invalid Kafka event identity.");
  }
  return JSON.stringify([topic, partition, offset]);
}

function isValidTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isValidCandidate(candidate) {
  return candidate === null || (
    candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    typeof candidate.symbol === "string" && candidate.symbol.length > 0 &&
    candidate.alertType === "SPIKE" &&
    typeof candidate.message === "string" && candidate.message.length > 0 &&
    typeof candidate.percentChange === "number" && Number.isFinite(candidate.percentChange) &&
    isValidTimestamp(candidate.timestamp) &&
    isPositiveNumber(candidate.previousPrice) &&
    isPositiveNumber(candidate.currentPrice) &&
    isValidTimestamp(candidate.comparisonTimestamp) &&
    isPositiveNumber(candidate.windowMs)
  );
}

function validateDecision(decision, id, description = "persisted alert decision") {
  if (
    !decision ||
    typeof decision !== "object" ||
    Array.isArray(decision) ||
    decision._id !== id ||
    !Object.prototype.hasOwnProperty.call(decision, "alertCandidate") ||
    !isValidCandidate(decision.alertCandidate) ||
    !(decision.previousPrice === null || isPositiveNumber(decision.previousPrice)) ||
    typeof decision.percentChange !== "number" ||
    !Number.isFinite(decision.percentChange)
  ) {
    throw new Error(`Invalid ${description} for Kafka event ${id}.`);
  }
  return decision;
}

function createAlertDecisionStore(collection, groupId) {
  if (typeof groupId !== "string" || groupId.trim() === "") {
    throw new Error("Invalid Kafka consumer group ID.");
  }

  function validateStored(decision, identity, id) {
    validateDecision(decision, id);
    const fields = ["groupId", "topic", "partition", "offset"];
    const present = fields.filter((field) => Object.prototype.hasOwnProperty.call(decision, field));
    if (present.length === 0) {
      console.warn(`Legacy alert decision ${id} has no cleanup metadata; ownership requires controlled migration.`);
      return decision;
    }
    if (
      present.length !== fields.length ||
      typeof decision.groupId !== "string" ||
      decision.groupId.trim() === "" ||
      decision.topic !== identity.topic ||
      decision.partition !== identity.partition ||
      !Long.isLong(decision.offset) ||
      decision.offset.toString() !== identity.offset
    ) {
      throw new Error(`Invalid alert decision metadata for Kafka event ${id}.`);
    }
    if (decision.groupId !== groupId) {
      throw new Error(`Conflicting consumer group ownership for Kafka event ${id}.`);
    }
    return decision;
  }

  async function find(identity) {
    const id = eventIdentity(identity);
    const decision = await collection.findOne({ _id: id }, { promoteLongs: false });
    return decision === null ? null : validateStored(decision, identity, id);
  }

  async function insertOriginal(identity, decision) {
    const id = eventIdentity(identity);
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      throw new Error(`Invalid alert decision input for Kafka event ${id}.`);
    }
    const document = {
      _id: id,
      groupId,
      topic: identity.topic,
      partition: identity.partition,
      offset: Long.fromString(identity.offset),
      alertCandidate: decision.alertCandidate,
      previousPrice: decision.previousPrice,
      percentChange: decision.percentChange,
    };
    validateDecision(document, id, "alert decision input");

    let persisted;
    try {
      persisted = await collection.findOneAndUpdate(
        { _id: id },
        { $setOnInsert: document },
        { upsert: true, returnDocument: "after", promoteLongs: false }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      persisted = await collection.findOne({ _id: id }, { promoteLongs: false });
      if (persisted === null) throw error;
    }
    return validateStored(persisted, identity, id);
  }

  return { find, insertOriginal };
}

module.exports = { createAlertDecisionStore };
