const { performance } = require("node:perf_hooks");
const { Long } = require("mongodb");

const INTERVAL_MS = 60_000;
const SAMPLE_LIMIT = 100;
const MAX_OFFSET = 9223372036854775807n;

function validOffset(offset) {
  return typeof offset === "string" &&
    /^(0|[1-9][0-9]*)$/.test(offset) &&
    BigInt(offset) <= MAX_OFFSET;
}

async function inspectEligible(collection, groupId, topic, partition, offset) {
  const documents = await collection.find({
    groupId,
    topic,
    partition,
    offset: { $type: "long", $gte: Long.ZERO, $lt: Long.fromString(offset) },
  }, {
    projection: { _id: 1, groupId: 1, topic: 1, partition: 1, offset: 1 },
    promoteLongs: false,
  }).hint("decision_group_topic_partition_offset")
    .sort({ offset: 1 }).limit(SAMPLE_LIMIT).toArray();

  const valid = documents.filter((document) =>
    document.groupId === groupId &&
    document.topic === topic &&
    document.partition === partition &&
    Long.isLong(document.offset) &&
    !document.offset.isNegative() &&
    BigInt(document.offset.toString()) < BigInt(offset) &&
    document._id === JSON.stringify([topic, partition, document.offset.toString()])
  );
  return { eligibleSampleCount: valid.length, inspectedSampleCount: documents.length };
}

function createCommitReconciliation({ admin, collection, groupId, topic }) {
  let running = false;
  let stopped = false;
  let active;
  let connected = false;
  let attemptedConnect = false;
  let timer;
  const pending = new Set();
  const last = new Map();

  async function cycle(sources) {
    const started = performance.now();
    const partitions = [];
    try {
      if (!connected) {
        attemptedConnect = true;
        await admin.connect();
        connected = true;
      }
      const response = await admin.fetchOffsets({
        groupId, topics: [topic], resolveOffsets: false,
      });
      if (!Array.isArray(response) || response.length !== 1 ||
          response[0].topic !== topic || !Array.isArray(response[0].partitions) ||
          response[0].partitions.length === 0) {
        last.clear();
        throw new Error("Uncertain Kafka committed-offset response.");
      }
      const entries = response[0].partitions;
      const seen = new Set();
      for (const entry of entries) {
        if (!entry || !Number.isInteger(entry.partition) || entry.partition < 0 ||
            entry.partition > 2147483647 || seen.has(entry.partition)) {
          last.clear();
          throw new Error("Invalid or duplicate Kafka partition in committed-offset response.");
        }
        seen.add(entry.partition);
      }
      for (const partition of last.keys()) {
        if (!seen.has(partition)) last.delete(partition);
      }
      for (const entry of entries) {
        const { partition, offset } = entry;
        if (!validOffset(offset)) {
          last.delete(partition);
          partitions.push({ partition, state: "missing-or-uncertain", eligibleSampleCount: null });
          continue;
        }
        const previous = last.get(partition);
        const decreased = previous !== undefined && BigInt(offset) < BigInt(previous);
        last.set(partition, offset);
        try {
          const sample = await inspectEligible(collection, groupId, topic, partition, offset);
          partitions.push({
            partition, state: decreased ? "decreased" : "verified",
            committedNextOffset: offset, ...sample, sampleLimit: SAMPLE_LIMIT,
          });
        } catch (error) {
          partitions.push({
            partition, state: "inspection-failed", committedNextOffset: offset,
            eligibleSampleCount: null, error: error.message,
          });
        }
      }
      console.log("Commit reconciliation:", JSON.stringify({
        triggers: sources, groupId, topic, partitions,
        durationMs: performance.now() - started,
        retry: partitions.some((entry) => entry.state === "inspection-failed")
          ? "next trigger or periodic cycle" : "not needed",
      }));
    } catch (error) {
      last.clear();
      console.error("Commit reconciliation failed:", JSON.stringify({
        triggers: sources, groupId, topic, durationMs: performance.now() - started,
        error: error.message, retry: "next trigger or periodic cycle",
      }));
    }
  }

  function schedule(source) {
    if (!running || stopped) return;
    pending.add(source);
    if (active) return;
    active = Promise.resolve().then(async () => {
      while (pending.size && !stopped) {
        const sources = [...pending];
        pending.clear();
        await cycle(sources);
      }
    }).catch((error) => {
      console.error("Commit reconciliation worker failed:", error.message);
    }).finally(() => {
      active = undefined;
      if (pending.size && !stopped) schedule("coalesced");
    });
  }

  function start() {
    if (running || stopped) throw new Error("Commit reconciliation cannot be started twice.");
    running = true;
    timer = setInterval(() => schedule("periodic"), INTERVAL_MS);
    timer.unref();
    schedule("startup");
  }

  function stopScheduling() {
    stopped = true;
    pending.clear();
    if (timer) clearInterval(timer);
  }

  async function drain() {
    stopScheduling();
    if (active) await active;
    if (attemptedConnect) {
      await admin.disconnect();
      attemptedConnect = false;
      connected = false;
    }
  }

  return { start, schedule, stopScheduling, drain };
}

module.exports = { createCommitReconciliation, inspectEligible };
