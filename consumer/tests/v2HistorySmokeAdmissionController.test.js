const {
  CLOSE_REASONS,
  createHistorySmokeAdmissionController,
} = require("../v2/historySmokeAdmissionController");

test.each([0, 101, -1, 1.5, "10", null, undefined])(
  "rejects an invalid shared record limit: %s",
  (maxRecords) => {
    expect(() => createHistorySmokeAdmissionController({ maxRecords }))
      .toThrow("V2 history smoke admission limit must be an integer from 1 to 100.");
  },
);

test("synchronously reserves one shared capacity across partitions", () => {
  const controller = createHistorySmokeAdmissionController({ maxRecords: 5 });

  const first = controller.reserve(0, 4);
  const second = controller.reserve(3, 4);

  expect(first).toEqual({
    partitionId: 0,
    requestedRecords: 4,
    admittedRecords: 4,
    closeReason: null,
  });
  expect(second).toEqual({
    partitionId: 3,
    requestedRecords: 4,
    admittedRecords: 1,
    closeReason: CLOSE_REASONS.LIMIT_REACHED,
  });
  expect(first).not.toBeInstanceOf(Promise);
  expect(second).not.toBeInstanceOf(Promise);
  expect(controller.snapshot()).toEqual({
    maxRecords: 5,
    admittedRecords: 5,
    remainingRecords: 0,
    closed: true,
    closeReason: "limit-reached",
  });
});

test("never refunds reservations, including records that callers do not persist", () => {
  const controller = createHistorySmokeAdmissionController({ maxRecords: 4 });

  controller.reserve(1, 3);
  expect(controller.snapshot().admittedRecords).toBe(3);
  expect(controller.refund).toBeUndefined();
  expect(controller.reserve(2, 2).admittedRecords).toBe(1);
  expect(controller.snapshot().admittedRecords).toBe(4);
});

test.each([
  [CLOSE_REASONS.DEADLINE],
  [CLOSE_REASONS.SHUTDOWN],
])("closes admission with the distinct %s reason", (reason) => {
  const controller = createHistorySmokeAdmissionController({ maxRecords: 6 });
  const state = controller.close(reason);

  expect(state).toEqual({
    maxRecords: 6,
    admittedRecords: 0,
    remainingRecords: 6,
    closed: true,
    closeReason: reason,
  });
  expect(controller.reserve(5, 1)).toEqual({
    partitionId: 5,
    requestedRecords: 1,
    admittedRecords: 0,
    closeReason: reason,
  });
});

test("preserves the first closure reason", () => {
  const controller = createHistorySmokeAdmissionController({ maxRecords: 1 });
  controller.reserve(0, 1);

  expect(controller.close(CLOSE_REASONS.DEADLINE).closeReason)
    .toBe(CLOSE_REASONS.LIMIT_REACHED);
});

test("returns immutable snapshots that do not change with later reservations", () => {
  const controller = createHistorySmokeAdmissionController({ maxRecords: 5 });
  const before = controller.snapshot();

  expect(Object.isFrozen(before)).toBe(true);
  controller.reserve(2, 2);

  expect(before).toEqual({
    maxRecords: 5,
    admittedRecords: 0,
    remainingRecords: 5,
    closed: false,
    closeReason: null,
  });
  expect(controller.snapshot().admittedRecords).toBe(2);
});

test.each([
  [-1, 1],
  [6, 1],
  [0, 0],
  [0, -1],
  [0, 1.5],
  [0, Number.MAX_SAFE_INTEGER + 1],
])("rejects invalid reservation partition/count (%s, %s)", (partitionId, count) => {
  const controller = createHistorySmokeAdmissionController({ maxRecords: 3 });

  expect(() => controller.reserve(partitionId, count))
    .toThrow("Invalid V2 history smoke admission reservation.");
  expect(controller.snapshot().admittedRecords).toBe(0);
});

test("uses no timers while reserving or closing admission", () => {
  const setTimeoutSpy = jest.spyOn(global, "setTimeout");
  try {
    const controller = createHistorySmokeAdmissionController({ maxRecords: 2 });
    controller.reserve(0, 1);
    controller.close(CLOSE_REASONS.SHUTDOWN);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  } finally {
    setTimeoutSpy.mockRestore();
  }
});
