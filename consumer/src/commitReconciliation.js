const { performance } = require("node:perf_hooks");
const { Long } = require("mongodb");
const { isValidDecision } = require("./alertDecisionStore");

const INTERVAL_MS = 60_000;
const SAMPLE_LIMIT = 100;
const CLEANUP_BATCH_SIZE = 500;
const CLEANUP_BATCHES_PER_CYCLE = 4;
const CATCH_UP_DELAY_MS = 50;
const MAX_NO_PROGRESS_CYCLES = 8;
const DECISION_INDEX = "decision_group_topic_partition_offset";
const CLEANUP_INDEX = "decision_cleanup_pagination";
const MAX_OFFSET = 9223372036854775807n;

function validOffset(offset) {
  return typeof offset === "string" &&
    /^(0|[1-9][0-9]*)$/.test(offset) &&
    BigInt(offset) <= MAX_OFFSET;
}

function decisionFilter(groupId, topic, partition, offset) {
  return {
    groupId, topic, partition,
    offset: { $type: "long", $gte: Long.ZERO, $lt: Long.fromString(offset) },
  };
}

function validMetadata(document, groupId, topic, partition, offset) {
  return document.groupId === groupId &&
    document.topic === topic &&
    document.partition === partition &&
    Long.isLong(document.offset) &&
    !document.offset.isNegative() &&
    BigInt(document.offset.toString()) < BigInt(offset) &&
    document._id === JSON.stringify([topic, partition, document.offset.toString()]);
}

function parseOffsets(response, topic) {
  if (!Array.isArray(response) || response.length !== 1 ||
      response[0].topic !== topic || !Array.isArray(response[0].partitions) ||
      response[0].partitions.length === 0) {
    throw new Error("Uncertain Kafka committed-offset response.");
  }
  const seen = new Set();
  for (const entry of response[0].partitions) {
    if (!entry || !Number.isInteger(entry.partition) || entry.partition < 0 ||
        entry.partition > 2147483647 || seen.has(entry.partition)) {
      throw new Error("Invalid or duplicate Kafka partition in committed-offset response.");
    }
    seen.add(entry.partition);
  }
  return response[0].partitions;
}

async function inspectEligible(collection, groupId, topic, partition, offset) {
  const documents = await collection.find(decisionFilter(groupId, topic, partition, offset), {
    projection: { _id: 1, groupId: 1, topic: 1, partition: 1, offset: 1 },
    promoteLongs: false,
  }).hint(DECISION_INDEX)
    .sort({ offset: 1 }).limit(SAMPLE_LIMIT).toArray();

  const valid = documents.filter((document) => validMetadata(document, groupId, topic, partition, offset));
  return { eligibleSampleCount: valid.length, inspectedSampleCount: documents.length };
}

async function selectCleanupCandidates(collection, groupId, topic, partition, offset, cursor) {
  const filter = {
    ...decisionFilter(groupId, topic, partition, offset),
    _id: { $type: "string" },
    $expr: { $and: [
      { $eq: [{ $type: "$groupId" }, "string"] },
      { $eq: [{ $type: "$topic" }, "string"] },
      { $in: [{ $type: "$partition" }, ["int", "double"]] },
      { $eq: [{ $type: "$offset" }, "long"] },
    ] },
  };
  if (cursor) {
    filter.$or = [
      { offset: { $gt: cursor.offset } },
      { offset: cursor.offset, _id: { $gt: cursor.id } },
    ];
  }
  const documents = await collection.find(filter, {
    promoteLongs: false,
  }).hint(CLEANUP_INDEX).sort({ offset: 1, _id: 1 }).limit(CLEANUP_BATCH_SIZE).toArray();
  const last = documents[documents.length - 1];
  return {
    documents: documents.filter((document) =>
      validMetadata(document, groupId, topic, partition, offset) &&
      isValidDecision(document, document._id)),
    inspected: documents.length,
    nextCursor: documents.length === CLEANUP_BATCH_SIZE
      ? { offset: last.offset, id: last._id } : null,
  };
}

function cleanupDeletionFilter(groupId, topic, partition, offset, documents) {
  return {
    ...decisionFilter(groupId, topic, partition, offset),
    $expr: { $and: [
      { $eq: [{ $type: "$groupId" }, "string"] },
      { $eq: [{ $type: "$topic" }, "string"] },
      { $in: [{ $type: "$partition" }, ["int", "double"]] },
      { $eq: [{ $type: "$offset" }, "long"] },
    ] },
    $or: documents.map((document) => ({
      _id: document._id,
      offset: document.offset,
      $expr: { $and: [
        { $ne: [{ $type: "$alertCandidate" }, "missing"] },
        { $ne: [{ $type: "$previousPrice" }, "missing"] },
        { $ne: [{ $type: "$percentChange" }, "missing"] },
        { $eq: ["$alertCandidate", { $literal: document.alertCandidate }] },
        { $eq: ["$previousPrice", { $literal: document.previousPrice }] },
        { $eq: ["$percentChange", { $literal: document.percentChange }] },
      ] },
    })),
  };
}

function createCommitReconciliation({ admin, collection, groupId, topic, cleanupEnabled = false }) {
  if (typeof cleanupEnabled !== "boolean") throw new Error("Invalid decision cleanup setting.");
  if (cleanupEnabled && (typeof groupId !== "string" || !groupId.trim() ||
      typeof topic !== "string" || !topic.trim())) {
    throw new Error("Decision cleanup requires a configured consumer group and topic.");
  }
  let running = false;
  let stopped = false;
  let active;
  let connected = false;
  let attemptedConnect = false;
  let timer;
  let followUpTimer;
  const pending = new Set();
  const last = new Map();
  const cleanupCursors = new Map();
  let partitionCursor = 0;
  let noProgressCycles = 0;
  let emptyPartitionsVisited = 0;

  async function fetchOffsets() {
    return parseOffsets(await admin.fetchOffsets({
      groupId, topics: [topic], resolveOffsets: false,
    }), topic);
  }

  async function cycle(sources) {
    const started = performance.now();
    const partitions = [];
    const cleanup = { enabled: cleanupEnabled, batchesAttempted: 0, deleted: 0 };
    if (sources.some((source) => source !== "catch-up")) {
      noProgressCycles = 0;
      emptyPartitionsVisited = 0;
    }
    try {
      if (!connected) {
        attemptedConnect = true;
        await admin.connect();
        connected = true;
      }
      const entries = await fetchOffsets();
      const seen = new Set(entries.map((entry) => entry.partition));
      for (const partition of last.keys()) {
        if (!seen.has(partition)) {
          last.delete(partition);
          cleanupCursors.delete(partition);
        }
      }
      for (const entry of entries) {
        const { partition, offset } = entry;
        if (!validOffset(offset)) {
          last.delete(partition);
          cleanupCursors.delete(partition);
          partitions.push({ partition, state: "missing-or-uncertain", eligibleSampleCount: null });
          continue;
        }
        const previous = last.get(partition);
        const decreased = previous !== undefined && BigInt(offset) < BigInt(previous);
        if (decreased) cleanupCursors.delete(partition);
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
      if (cleanupEnabled) {
        const cleanupStarted = performance.now();
        const ordered = [...partitions].sort((a, b) => a.partition - b.partition);
        const count = ordered.length;
        const start = partitionCursor % count;
        let visited = 0;
        while (visited < count && visited < CLEANUP_BATCHES_PER_CYCLE && !stopped) {
          const entry = ordered[(start + visited) % count];
          visited += 1;
          if (entry.state !== "verified") continue;
          const { partition, committedNextOffset: boundary } = entry;
          const result = { partition, state: "complete", deleted: 0 };
          if (!cleanup.partitions) cleanup.partitions = [];
          cleanup.partitions.push(result);
          try {
            const selected = await selectCleanupCandidates(
              collection, groupId, topic, partition, boundary, cleanupCursors.get(partition)
            );
            result.inspected = selected.inspected;
            result.selected = selected.documents.length;
            result.ambiguous = selected.inspected - selected.documents.length;
            result.morePossible = selected.inspected === CLEANUP_BATCH_SIZE;
            if (!selected.documents.length || stopped) {
              if (result.ambiguous) result.state = "ambiguous-records";
              if (!stopped) {
                if (selected.nextCursor) cleanupCursors.set(partition, selected.nextCursor);
                else cleanupCursors.delete(partition);
              }
              continue;
            }
            const refreshed = (await fetchOffsets()).find((item) => item.partition === partition);
            const next = refreshed && refreshed.offset;
            if (!validOffset(next) || BigInt(next) < BigInt(boundary)) {
              if (validOffset(next)) last.set(partition, next);
              else last.delete(partition);
              cleanupCursors.delete(partition);
              result.state = "boundary-changed-or-missing";
              result.revalidatedOffset = validOffset(next) ? next : null;
              continue;
            }
            last.set(partition, next);
            result.revalidatedOffset = next;
            if (stopped) break;
            cleanup.batchesAttempted += 1;
            result.deletionAttempted = true;
            const deleted = await collection.deleteMany(
              cleanupDeletionFilter(groupId, topic, partition, boundary, selected.documents),
              { hint: DECISION_INDEX }
            );
            result.deleted = deleted.deletedCount;
            cleanup.deleted += deleted.deletedCount;
            if (deleted.deletedCount !== selected.documents.length) result.state = "partial";
            else if (result.ambiguous) result.state = "ambiguous-records";
            if (selected.nextCursor) cleanupCursors.set(partition, selected.nextCursor);
            else cleanupCursors.delete(partition);
          } catch (error) {
            last.delete(partition);
            result.state = "failed";
            result.error = error.message;
            if (result.deletionAttempted) {
              result.deleted = null;
              cleanup.deletionCountUncertain = true;
            }
            result.retry = "next trigger or periodic cycle";
            console.error("Decision cleanup failed:", JSON.stringify({
              groupId, topic, ...result,
            }));
          }
        }
        partitionCursor = (start + visited) % count;
        const morePossible = (cleanup.partitions || []).some((entry) => entry.morePossible);
        cleanup.workLimitReached = visited < count || morePossible;
        const blocked = partitions.some((entry) =>
          entry.state === "inspection-failed" || entry.state === "decreased") ||
          (cleanup.partitions || []).some((entry) =>
            entry.state === "failed" || entry.state === "partial" ||
            entry.state === "boundary-changed-or-missing");
        if (cleanup.deleted > 0) {
          noProgressCycles = 0;
          emptyPartitionsVisited = 0;
        } else {
          noProgressCycles += 1;
          emptyPartitionsVisited = morePossible ? 0 : emptyPartitionsVisited + visited;
        }
        cleanup.followUpScheduled = !stopped && !blocked && cleanup.workLimitReached &&
          (cleanup.deleted > 0 ||
            (morePossible ? noProgressCycles < MAX_NO_PROGRESS_CYCLES :
              emptyPartitionsVisited < count));
        if (cleanup.workLimitReached && !cleanup.followUpScheduled) {
          cleanup.followUpDeferred = stopped ? "shutdown" :
            blocked ? "failure or uncertain boundary" : "no-progress limit or empty sweep";
        }
        cleanup.durationMs = performance.now() - cleanupStarted;
      }
      console.log("Commit reconciliation:", JSON.stringify({
        triggers: sources, groupId, topic, partitions,
        cleanup,
        durationMs: performance.now() - started,
        retry: partitions.some((entry) => entry.state === "inspection-failed") ||
          (cleanup.partitions || []).some((entry) => entry.state !== "complete")
          ? "next trigger or periodic cycle" : "not needed",
      }));
      return cleanup.followUpScheduled === true;
    } catch (error) {
      last.clear();
      console.error("Commit reconciliation failed:", JSON.stringify({
        triggers: sources, groupId, topic, durationMs: performance.now() - started,
        cleanup, error: error.message, retry: "next trigger or periodic cycle",
      }));
    }
  }

  function schedule(source) {
    if (!running || stopped) return;
    pending.add(source);
    if (active || followUpTimer) return;
    active = Promise.resolve().then(async () => {
      while (pending.size && !stopped) {
        const sources = [...pending];
        pending.clear();
        const followUp = await cycle(sources);
        if (followUp && !stopped) {
          followUpTimer = setTimeout(() => {
            followUpTimer = undefined;
            schedule("catch-up");
          }, CATCH_UP_DELAY_MS);
          followUpTimer.unref();
          break;
        }
      }
    }).catch((error) => {
      console.error("Commit reconciliation worker failed:", error.message);
    }).finally(() => {
      active = undefined;
      if (pending.size && !stopped && !followUpTimer) schedule("coalesced");
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
    if (followUpTimer) {
      clearTimeout(followUpTimer);
      followUpTimer = undefined;
    }
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
