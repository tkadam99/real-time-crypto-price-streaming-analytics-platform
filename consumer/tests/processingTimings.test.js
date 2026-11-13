const { createProcessingTimings } = require("../src/processingTimings");

describe("processing timing aggregation", () => {
  let time;
  let flush;
  let report;
  let timings;

  beforeEach(() => {
    time = 0;
    report = jest.fn();
    timings = createProcessingTimings({
      now: () => time,
      report,
      schedule: (callback, interval) => {
        expect(interval).toBe(60_000);
        flush = callback;
        return { unref: jest.fn() };
      },
    });
  });

  it("reports operation and event timings, optional operations, and failures by classification", () => {
    const first = timings.beginEvent();
    first.start("rawPersistence");
    time += 4;
    first.classify("new");
    first.end();
    first.start("retentionQuery");
    time += 6;
    first.end();
    first.finish(true);

    const replay = timings.beginEvent();
    replay.classify("replay");
    replay.start("rawPersistence");
    time += 2;
    replay.end();
    replay.start("retentionDeletion");
    time += 3;
    replay.finish(false);

    const unknown = timings.beginEvent();
    unknown.start("rawPersistence");
    time += 7;
    unknown.finish(false);
    flush();

    const summary = report.mock.calls[0][0];
    expect(summary).toMatchObject({
      successfulEvents: 1,
      failedAttempts: 2,
      totalSuccessfulProcessingMs: 10,
      classifications: {
        new: {
          successfulEvents: 1,
          failedAttempts: 0,
          operations: {
            rawPersistence: { count: 1, totalMs: 4, averageMs: 4, p50Ms: 4, p95Ms: 4 },
            retentionQuery: { count: 1, totalMs: 6 },
            predecessor: { count: 0, averageMs: null, p50Ms: null, p95Ms: null },
            successfulEvent: { count: 1, totalMs: 10 },
          },
        },
        replay: {
          successfulEvents: 0,
          failedAttempts: 1,
          operations: { retentionDeletion: { count: 1, totalMs: 3 } },
        },
        unknown: {
          failedAttempts: 1,
          operations: { rawPersistence: { count: 1, totalMs: 7 } },
        },
      },
    });
    flush();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("bounds samples while keeping full counts and totals", () => {
    for (let duration = 1; duration <= 1100; duration += 1) {
      const event = timings.beginEvent();
      event.classify("new");
      event.start("recentHistory");
      time += duration;
      event.end();
      event.finish(true);
    }
    flush();
    const operation = report.mock.calls[0][0].classifications.new.operations.recentHistory;
    expect(operation).toEqual({
      count: 1100,
      totalMs: 605550,
      averageMs: 550.5,
      sampleCount: 1024,
      p50Ms: 588,
      p95Ms: 1049,
    });
  });
});
