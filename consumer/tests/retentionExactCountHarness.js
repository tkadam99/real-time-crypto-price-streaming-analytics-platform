const { performance } = require("node:perf_hooks");
const { algorithms: { reference } } = require("./retentionHarness");

// Test-only: correctness requires one exclusive writer and acknowledged writes.
// Undetected external writes can corrupt the count; crashes and concurrency are unproven.
// Errors invalidate the count and are rethrown; the next attempt uses the full scan.
function createExactCountRetention(collection, target) {
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error("Invalid retention target.");
  const counts = new Map();
  let active = false;
  const fallbackCollection = {
    find: (...args) => collection.find(...args),
    async deleteMany(...args) {
      const result = await collection.deleteMany(...args);
      if (!result.acknowledged || !Number.isSafeInteger(result.deletedCount)) {
        throw new Error("Uncertain fallback deletion outcome.");
      }
      return result;
    },
  };

  function invalidate(symbol) {
    counts.delete(symbol);
  }

  async function rebuild(symbol, hooks, timings) {
    invalidate(symbol);
    const started = performance.now();
    try {
      const result = await reference(fallbackCollection, symbol, target, { ...hooks, timings });
      const count = await collection.countDocuments({ symbol });
      if (!Number.isSafeInteger(count) || count < 0 || count > target) {
        throw new Error("Cannot establish an exact retention count.");
      }
      counts.set(symbol, count);
      return result.deleted;
    } finally {
      timings.fallbackMs = performance.now() - started;
    }
  }

  async function exclusive(operation) {
    if (active) throw new Error("Concurrent retention operations are unsupported.");
    active = true;
    try {
      return await operation();
    } finally {
      active = false;
    }
  }

  return {
    invalidate(symbol) {
      if (active) throw new Error("Cannot invalidate an active retention operation.");
      invalidate(symbol);
    },
    initialize(symbol, hooks = {}) {
      return exclusive(async () => {
        const timings = { queryMs: 0, deleteMs: 0, fallbackMs: 0 };
        await rebuild(symbol, hooks, timings);
        return timings;
      });
    },
    process(document, hooks = {}) {
      return exclusive(async () => {
        const { _id, symbol, ...fields } = document;
        if (_id === undefined || typeof symbol !== "string" || !symbol) {
          throw new Error("Invalid retention event identity.");
        }
        const timings = { upsertMs: 0, queryMs: 0, deleteMs: 0, fallbackMs: 0 };
        try {
          if (hooks.beforeUpsert) await hooks.beforeUpsert();
          const upsertStarted = performance.now();
          const result = await collection.updateOne(
            { _id }, { $setOnInsert: { symbol, ...fields } }, { upsert: true }
          );
          timings.upsertMs = performance.now() - upsertStarted;
          if (!result.acknowledged ||
              !((result.upsertedCount === 1 && result.matchedCount === 0) ||
                (result.upsertedCount === 0 && result.matchedCount === 1))) {
            throw new Error("Uncertain raw-event upsert outcome.");
          }
          if (hooks.afterUpsert) await hooks.afterUpsert();
          if (!counts.has(symbol)) {
            const deleted = await rebuild(symbol, hooks, timings);
            return { path: "fallback", upserted: result.upsertedCount, queryIssued: true, deleted, timings };
          }

          const count = counts.get(symbol) + result.upsertedCount;
          if (count > target + 1) throw new Error("Unexpected retention count.");
          if (count > target) {
            if (hooks.beforeRead) await hooks.beforeRead();
            const queryStarted = performance.now();
            const oldest = await collection.find({ symbol })
              .sort({ timestamp: 1, receivedAt: 1, _id: 1 })
              .limit(1).project({ _id: 1 }).toArray();
            timings.queryMs = performance.now() - queryStarted;
            if (oldest.length !== 1) throw new Error("Unable to select the oldest retention record.");
            const filter = { symbol, _id: { $in: [oldest[0]._id] } };
            if (hooks.beforeDelete) await hooks.beforeDelete(filter);
            const deleteStarted = performance.now();
            const deletion = await collection.deleteMany(filter);
            timings.deleteMs = performance.now() - deleteStarted;
            if (!deletion.acknowledged || deletion.deletedCount !== 1) {
              throw new Error("Uncertain retention deletion outcome.");
            }
            counts.set(symbol, count - 1);
          } else {
            counts.set(symbol, count);
          }
          return {
            path: "exact-count", upserted: result.upsertedCount, queryIssued: count > target,
            deleted: count > target ? 1 : 0, timings,
          };
        } catch (error) {
          invalidate(symbol);
          throw error;
        }
      });
    },
  };
}

module.exports = { createExactCountRetention };
