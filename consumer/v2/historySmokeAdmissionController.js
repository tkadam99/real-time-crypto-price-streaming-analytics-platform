const PARTITION_COUNT = 6;

const CLOSE_REASONS = Object.freeze({
  LIMIT_REACHED: "limit-reached",
  DEADLINE: "deadline",
  SHUTDOWN: "shutdown",
});

function createHistorySmokeAdmissionController({ maxRecords } = {}) {
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100) {
    throw new Error("V2 history smoke admission limit must be an integer from 1 to 100.");
  }

  let admittedRecords = 0;
  let closeReason = null;

  function snapshot() {
    return Object.freeze({
      maxRecords,
      admittedRecords,
      remainingRecords: maxRecords - admittedRecords,
      closed: closeReason !== null,
      closeReason,
    });
  }

  function close(reason) {
    if (reason !== CLOSE_REASONS.DEADLINE &&
        reason !== CLOSE_REASONS.SHUTDOWN) {
      throw new Error("Invalid V2 history smoke admission closure reason.");
    }
    if (closeReason === null) closeReason = reason;
    return snapshot();
  }

  function reserve(partitionId, requestedRecords) {
    if (!Number.isInteger(partitionId) ||
        partitionId < 0 ||
        partitionId >= PARTITION_COUNT ||
        !Number.isSafeInteger(requestedRecords) ||
        requestedRecords < 1) {
      throw new Error("Invalid V2 history smoke admission reservation.");
    }

    if (closeReason !== null) {
      return Object.freeze({
        partitionId,
        requestedRecords,
        admittedRecords: 0,
        closeReason,
      });
    }

    const admitted = Math.min(requestedRecords, maxRecords - admittedRecords);
    admittedRecords += admitted;
    if (admittedRecords === maxRecords) {
      closeReason = CLOSE_REASONS.LIMIT_REACHED;
    }

    return Object.freeze({
      partitionId,
      requestedRecords,
      admittedRecords: admitted,
      closeReason,
    });
  }

  return Object.freeze({
    close,
    reserve,
    snapshot,
  });
}

module.exports = {
  CLOSE_REASONS,
  createHistorySmokeAdmissionController,
};
