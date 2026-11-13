const { performance } = require("node:perf_hooks");

const REPORT_INTERVAL_MS = 60_000;
const SAMPLE_LIMIT = 1024;
const OPERATIONS = [
  "decisionPersistence",
  "rawPersistence",
  "recentHistory",
  "predecessor",
  "metricsCalculation",
  "metricsPersistence",
  "retentionQuery",
  "retentionDeletion",
  "alertPersistence",
  "successfulEvent",
];
const CLASSIFICATIONS = ["new", "replay", "unknown"];

function createStats() {
  return { count: 0, totalMs: 0, samples: [] };
}

function addSample(stats, duration) {
  stats.samples[stats.count % SAMPLE_LIMIT] = duration;
  stats.count += 1;
  stats.totalMs += duration;
}

function summarize(stats) {
  const sorted = [...stats.samples].sort((a, b) => a - b);
  const percentile = (fraction) =>
    sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  return {
    count: stats.count,
    totalMs: stats.totalMs,
    averageMs: stats.count ? stats.totalMs / stats.count : null,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    sampleCount: sorted.length,
  };
}

function createProcessingTimings({
  now = () => performance.now(),
  report = (summary) => console.log("Consumer processing timings:", JSON.stringify(summary)),
  schedule = setInterval,
} = {}) {
  let groups = createGroups();

  function createGroups() {
    return Object.fromEntries(CLASSIFICATIONS.map((classification) => [
      classification,
      {
        successfulEvents: 0,
        failedAttempts: 0,
        operations: Object.fromEntries(OPERATIONS.map((name) => [name, createStats()])),
      },
    ]));
  }

  function flush() {
    const snapshot = groups;
    const successfulEvents = CLASSIFICATIONS.reduce(
      (sum, name) => sum + snapshot[name].successfulEvents, 0
    );
    const failedAttempts = CLASSIFICATIONS.reduce(
      (sum, name) => sum + snapshot[name].failedAttempts, 0
    );
    if (successfulEvents + failedAttempts === 0) return;
    groups = createGroups();
    report({
      successfulEvents,
      failedAttempts,
      totalSuccessfulProcessingMs: CLASSIFICATIONS.reduce(
        (sum, name) => sum + snapshot[name].operations.successfulEvent.totalMs, 0
      ),
      classifications: Object.fromEntries(CLASSIFICATIONS.map((name) => [
        name,
        {
          successfulEvents: snapshot[name].successfulEvents,
          failedAttempts: snapshot[name].failedAttempts,
          operations: Object.fromEntries(OPERATIONS.map((operation) => [
            operation, summarize(snapshot[name].operations[operation]),
          ])),
        },
      ])),
    });
  }

  const timer = schedule(flush, REPORT_INTERVAL_MS);
  timer.unref();

  function beginEvent() {
    const eventStart = now();
    const measurements = [];
    let active;
    let classification = "unknown";
    return {
      classify(value) {
        classification = value;
      },
      start(name) {
        active = { name, started: now() };
      },
      end() {
        if (active) {
          measurements.push([active.name, now() - active.started]);
          active = undefined;
        }
      },
      finish(success) {
        this.end();
        const group = groups[classification];
        if (success) {
          group.successfulEvents += 1;
          addSample(group.operations.successfulEvent, now() - eventStart);
        } else {
          group.failedAttempts += 1;
        }
        for (const [name, duration] of measurements) {
          addSample(group.operations[name], duration);
        }
      },
    };
  }

  return { beginEvent };
}

module.exports = { createProcessingTimings };
