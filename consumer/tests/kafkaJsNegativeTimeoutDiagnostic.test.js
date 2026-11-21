const RequestQueue = require("kafkajs/src/network/requestQueue");

function createRequestQueue() {
  return new RequestQueue({
    maxInFlightRequests: 5,
    requestTimeout: 30000,
    enforceRequestTimeout: false,
    clientId: "negative-timeout-diagnostic",
    broker: "localhost:9092",
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
}

function captureScheduledTimers() {
  const scheduled = [];
  const setTimeoutSpy = jest.spyOn(global, "setTimeout")
    .mockImplementation((callback, delay) => {
      scheduled.push({ callback, delay });
      return { diagnosticTimer: scheduled.length };
    });

  return { scheduled, setTimeoutSpy };
}

afterEach(() => {
  jest.restoreAllMocks();
});

test("does not schedule an idle timer for an empty request queue", () => {
  const { scheduled } = captureScheduledTimers();
  const queue = createRequestQueue();

  expect(queue.pending).toHaveLength(0);
  expect(queue.throttledUntil).toBe(-1);

  queue.checkPendingRequests();
  expect(scheduled).toHaveLength(0);
});

test("schedules a positive timeout for queued requests under active throttling", () => {
  const { scheduled } = captureScheduledTimers();
  const queue = createRequestQueue();
  queue.pending.push({});
  queue.throttledUntil = Date.now() + 1000;

  queue.scheduleCheckPendingRequests();

  expect(scheduled).toHaveLength(1);
  expect(scheduled[0].delay).toBeGreaterThan(0);
  expect(scheduled[0].delay).toBeLessThanOrEqual(1000);

  queue.throttleCheckTimeoutId = null;
});
