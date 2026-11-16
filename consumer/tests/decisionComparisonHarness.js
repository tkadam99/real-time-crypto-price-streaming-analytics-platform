const { performance } = require("node:perf_hooks");
const { BSON, Long } = require("mongodb");
const { isDeepStrictEqual } = require("node:util");
const { createAlertDecisionStore, isValidDecision } = require("../src/alertDecisionStore");
const { buildAlert } = require("../src/analytics");

const GROUP = "decision-comparison-group";
const EMPTY = { alertCandidate: null, previousPrice: null, percentChange: 0 };
const POSITIVE = {
  alertCandidate: buildAlert("BTC-USD", 2, 102, 100, "2026-01-01T00:01:00Z", "2026-01-01T00:00:00Z", 60000),
  previousPrice: 100,
  percentChange: 2,
};

function identity(offset) {
  return { topic: "decision-comparison-topic", partition: 0, offset: String(offset) };
}

function idOf(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) ||
      typeof item.topic !== "string" || !item.topic.trim() ||
      !Number.isInteger(item.partition) || item.partition < 0 || item.partition > 2147483647 ||
      typeof item.offset !== "string" || !/^(0|[1-9][0-9]*)$/.test(item.offset) ||
      BigInt(item.offset) > 9223372036854775807n) {
    throw new Error("Invalid Kafka event identity.");
  }
  return JSON.stringify([item.topic, item.partition, item.offset]);
}

function reference(collection, group = GROUP) {
  return createAlertDecisionStore(collection, group);
}

function experimental(collection, group = GROUP) {
  const original = createAlertDecisionStore(collection, group);
  return {
    find: original.find,
    async insertOriginal(item, decision) {
      const id = idOf(item);
      if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
        throw new Error(`Invalid alert decision input for Kafka event ${id}.`);
      }
      const document = {
        _id: id, groupId: group, topic: item.topic, partition: item.partition,
        offset: Long.fromString(item.offset), alertCandidate: decision.alertCandidate,
        previousPrice: decision.previousPrice, percentChange: decision.percentChange,
      };
      if (!isValidDecision(document, id)) {
        throw new Error(`Invalid alert decision input for Kafka event ${id}.`);
      }
      const roundTrip = BSON.deserialize(BSON.serialize(document), { promoteLongs: false });
      if (!isDeepStrictEqual(document, roundTrip)) {
        throw new Error(`Experimental candidate is not BSON-round-trip equivalent for Kafka event ${id}.`);
      }
      let result;
      try {
        result = await collection.updateOne({ _id: id }, { $setOnInsert: document }, { upsert: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
        const winner = await original.find(item);
        if (winner === null) throw error;
        return winner;
      }
      if (!result.acknowledged) throw new Error(`Unacknowledged decision write for Kafka event ${id}.`);
      if (result.upsertedCount === 1 && result.upsertedId === id && result.matchedCount === 0) return document;
      if (result.upsertedCount !== 0 || result.matchedCount !== 1) {
        throw new Error(`Unexpected decision write result for Kafka event ${id}.`);
      }
      const winner = await original.find(item);
      if (winner === null) throw new Error(`Matched decision disappeared for Kafka event ${id}.`);
      return winner;
    },
  };
}

async function setupIndexes(collection) {
  await collection.createIndex(
    { groupId: 1, topic: 1, partition: 1, offset: 1 },
    { name: "decision_group_topic_partition_offset" }
  );
}

function timedCollection(collection, timings) {
  return new Proxy(collection, {
    get(target, property) {
      const method = target[property];
      if (typeof method !== "function") return method;
      if (!["findOne", "findOneAndUpdate", "updateOne"].includes(property)) return method.bind(target);
      return async (...args) => {
        const start = performance.now();
        try {
          return await method.apply(target, args);
        } finally {
          const field = property === "findOne" ? "readMs" : "writeMs";
          timings[field] += performance.now() - start;
        }
      };
    },
  });
}

async function decide(store, raw, item, proposed) {
  let decision = await store.find(item);
  if (!decision) {
    const legacy = await raw.findOne({ _id: idOf(item) });
    const original = legacy && legacy.alertCandidate !== undefined
      ? { alertCandidate: legacy.alertCandidate, previousPrice: legacy.previousPrice, percentChange: legacy.percentChange }
      : proposed;
    decision = await store.insertOriginal(item, original);
  }
  return decision;
}

module.exports = {
  EMPTY, GROUP, POSITIVE, decide, experimental, idOf, identity, reference, setupIndexes, timedCollection,
};
