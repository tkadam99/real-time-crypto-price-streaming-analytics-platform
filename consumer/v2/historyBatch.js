const { deriveEventIdentity } = require("./historyContract");
const { persistHistoryEvent } = require("./historyPersistence");

const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const MAX_ENVELOPES = 100;

function validateOptions({ envelopes, batchSize, concurrency, insertedAt }) {
  if (!Array.isArray(envelopes)) {
    throw new Error("History batch envelopes must be an array.");
  }
  if (envelopes.length > MAX_ENVELOPES) {
    throw new Error(`History batches cannot exceed ${MAX_ENVELOPES} envelopes.`);
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be between 1 and ${MAX_BATCH_SIZE}.`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`concurrency must be between 1 and ${MAX_CONCURRENCY}.`);
  }
  if (insertedAt !== undefined &&
      (!(insertedAt instanceof Date) || !Number.isFinite(insertedAt.getTime()))) {
    throw new Error("History insertion time must be a valid Date.");
  }
}

function failedResult(index, error, eventIdentity) {
  return {
    index,
    status: "failed",
    ...(eventIdentity === undefined ? {} : { eventIdentity }),
    error,
  };
}

async function persistHistoryBatch({
  client,
  historyCollection,
  receiptCollection,
  envelopes,
  batchSize = DEFAULT_BATCH_SIZE,
  concurrency = DEFAULT_CONCURRENCY,
  insertedAt,
}) {
  validateOptions({ envelopes, batchSize, concurrency, insertedAt });

  const results = new Array(envelopes.length);
  const prepared = envelopes.map((envelope, index) => {
    try {
      return { index, envelope, eventIdentity: deriveEventIdentity(envelope) };
    } catch (error) {
      results[index] = failedResult(index, error);
      return null;
    }
  });

  for (let batchStart = 0; batchStart < prepared.length; batchStart += batchSize) {
    const batchEnd = Math.min(batchStart + batchSize, prepared.length);
    let nextIndex = batchStart;

    async function worker() {
      while (nextIndex < batchEnd) {
        const index = nextIndex;
        nextIndex += 1;
        const item = prepared[index];
        if (item === null) continue;

        try {
          const persistenceResult = await persistHistoryEvent({
            client,
            historyCollection,
            receiptCollection,
            envelope: item.envelope,
            insertedAt,
          });
          if (!persistenceResult ||
              !["inserted", "replay"].includes(persistenceResult.status) ||
              persistenceResult.eventIdentity !== item.eventIdentity) {
            throw new Error("History persistence returned an invalid result.");
          }
          results[index] = {
            index,
            status: persistenceResult.status,
            eventIdentity: item.eventIdentity,
          };
        } catch (error) {
          results[index] = failedResult(index, error, item.eventIdentity);
        }
      }
    }

    const workerCount = Math.min(concurrency, batchEnd - batchStart);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  const counts = { inserted: 0, replay: 0, failed: 0 };
  for (const result of results) counts[result.status] += 1;
  return { ...counts, total: results.length, results };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  MAX_ENVELOPES,
  persistHistoryBatch,
};
