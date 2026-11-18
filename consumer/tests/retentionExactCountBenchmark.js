// Test-only experiment. Use an independently verified disposable MongoDB deployment.
// The candidate assumes one exclusive writer; crash and concurrency safety are unproven.
require("dotenv").config({ quiet: true });
const { performance } = require("node:perf_hooks");
const { MongoClient } = require("mongodb");
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");
const {
  createIndexes, event, ordered, algorithms: { reference }, referenceQuery, validateRetention,
} = require("./retentionHarness");
const { extractPlan } = require("./retentionBenchmarkUtils");
const { createExactCountRetention } = require("./retentionExactCountHarness");

const TARGET = 10000;
const SYMBOLS = ["BTC-USD", "ETH-USD"];

function setting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return Number(raw);
}

function summarize(values) {
  if (!values.length) return { count: 0, totalMs: 0, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    totalMs: values.reduce((sum, value) => sum + value, 0),
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function statistics(samples) {
  const duration = samples.reduce((sum, sample) => sum + sample.processingMs, 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid processing duration.");
  return {
    processing: summarize(samples.map((sample) => sample.processingMs)),
    upsert: summarize(samples.map((sample) => sample.timings.upsertMs)),
    query: summarize(samples.filter((sample) => sample.queryIssued).map((sample) => sample.timings.queryMs)),
    deletion: summarize(samples.filter((sample) => sample.deleted > 0).map((sample) => sample.timings.deleteMs)),
    fallback: summarize(samples.filter((sample) => sample.path === "fallback").map((sample) => sample.timings.fallbackMs)),
    simulatedEventsPerSecond: samples.length * 1000 / duration,
  };
}

async function main() {
  const uri = getMongoIntegrationUri(process.env);
  if (!uri) throw new Error("MONGO_INTEGRATION_URI must identify an independently verified disposable deployment.");
  const uriDatabase = decodeURIComponent(new URL(uri).pathname.slice(1));
  if (uriDatabase.toLowerCase() === "crypto_analytics") {
    throw new Error("The application database must not be used by this experiment.");
  }
  const warmup = setting("RETENTION_EXACT_BENCH_WARMUP", 1, 0, 5);
  const trials = setting("RETENTION_EXACT_BENCH_TRIALS", 3, 1, 10);
  const steps = setting("RETENTION_EXACT_BENCH_STEPS", 20, 2, 200);
  const seed = SYMBOLS.flatMap((symbol) =>
    Array.from({ length: TARGET }, (_, index) => event(symbol, index))
  );
  const samples = { reference: [], candidate: [] };
  const throughputTrials = { reference: [], candidate: [] };
  const initialization = [];
  let plans;
  const client = new MongoClient(uri);
  let db;
  let output;
  try {
    await client.connect();
    db = createMongoTestDatabase(client, "retention_exact_bench");
    const baseline = db.collection("baseline");
    const candidate = db.collection("candidate");
    await createIndexes(baseline);
    await createIndexes(candidate);

    for (let trial = -warmup; trial < trials; trial++) {
      await baseline.deleteMany({});
      await candidate.deleteMany({});
      await baseline.insertMany(seed);
      await candidate.insertMany(seed);
      const experiment = createExactCountRetention(candidate, TARGET);
      for (const symbol of SYMBOLS) {
        const start = performance.now();
        const timings = await experiment.initialize(symbol);
        const durationMs = performance.now() - start;
        if (trial >= 0) initialization.push({ trial, symbol, durationMs, ...timings });
      }

      for (let step = 0; step < steps; step++) {
        const symbol = SYMBOLS[step % SYMBOLS.length];
        const document = event(symbol, TARGET + step + 1);
        if (step === Math.floor(steps / 2)) experiment.invalidate(symbol);
        const order = (trial + step) % 2 === 0
          ? ["reference", "candidate"] : ["candidate", "reference"];
        const outcomes = {};
        for (const name of order) {
          if (name === "reference") {
            const { _id, ...fields } = document;
            const upsertStart = performance.now();
            const upsert = await baseline.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
            const upsertMs = performance.now() - upsertStart;
            if (!upsert.acknowledged) throw new Error("Unacknowledged reference upsert.");
            const before = await ordered(baseline);
            if (trial === 0 && step === 0) {
              const referenceExplain = await referenceQuery(baseline, symbol, TARGET).explain("executionStats");
              const oldestExplain = await baseline.find({ symbol })
                .sort({ timestamp: 1, receivedAt: 1, _id: 1 })
                .limit(1).project({ _id: 1 }).explain("executionStats");
              plans = {
                reference: extractPlan(referenceExplain),
                candidateOldestOnReferenceCollection: extractPlan(oldestExplain),
              };
            }
            const timings = { upsertMs, queryMs: 0, deleteMs: 0, fallbackMs: 0 };
            const retentionStart = performance.now();
            const result = await reference(baseline, symbol, TARGET, { timings });
            const processingMs = upsertMs + performance.now() - retentionStart;
            const after = await ordered(baseline);
            validateRetention(before, after, symbol, TARGET, `trial ${trial}, step ${step}`);
            outcomes.reference = {
              trial, step, symbol, order, path: "reference", upserted: upsert.upsertedCount,
              queryIssued: true, deleted: result.deleted, timings, processingMs, after,
            };
          } else {
            await ordered(candidate);
            const start = performance.now();
            const result = await experiment.process(document);
            const processingMs = performance.now() - start;
            outcomes.candidate = { trial, step, symbol, order, ...result, processingMs, after: await ordered(candidate) };
          }
        }
        if (JSON.stringify(outcomes.reference.after) !== JSON.stringify(outcomes.candidate.after) ||
            outcomes.reference.upserted !== outcomes.candidate.upserted ||
            outcomes.reference.deleted !== outcomes.candidate.deleted) {
          throw new Error(`Retention mismatch in trial ${trial}, step ${step}.`);
        }
        if (trial >= 0) {
          for (const name of order) {
            const { after, ...sample } = outcomes[name];
            samples[name].push(sample);
          }
        }
      }

      await baseline.deleteMany({});
      await candidate.deleteMany({});
      await baseline.insertMany(seed);
      await candidate.insertMany(seed);
      const throughputExperiment = createExactCountRetention(candidate, TARGET);
      for (const symbol of SYMBOLS) await throughputExperiment.initialize(symbol);
      const continuousOrder = trial % 2 === 0
        ? ["reference", "candidate"] : ["candidate", "reference"];
      for (const name of continuousOrder) {
        const start = performance.now();
        for (let step = 0; step < steps; step++) {
          const symbol = SYMBOLS[step % SYMBOLS.length];
          const document = event(symbol, TARGET + step + 1);
          if (name === "candidate") {
            if (step === Math.floor(steps / 2)) throughputExperiment.invalidate(symbol);
            await throughputExperiment.process(document);
          } else {
            const { _id, ...fields } = document;
            const result = await baseline.updateOne({ _id }, { $setOnInsert: fields }, { upsert: true });
            if (!result.acknowledged) throw new Error("Unacknowledged reference upsert.");
            await reference(baseline, symbol, TARGET);
          }
        }
        const durationMs = performance.now() - start;
        if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Invalid throughput duration.");
        if (trial >= 0) throughputTrials[name].push({
          trial, order: continuousOrder, events: steps, durationMs, eventsPerSecond: steps * 1000 / durationMs,
        });
      }
      if (JSON.stringify(await ordered(baseline)) !== JSON.stringify(await ordered(candidate))) {
        throw new Error(`Continuous throughput pass mismatch in trial ${trial}.`);
      }
    }

    output = {
      success: true,
      settings: { target: TARGET, symbols: SYMBOLS, warmupTrials: warmup, measuredTrials: trials, stepsPerTrial: steps },
      assumptions: [
        "Exclusive writer and acknowledged writes are required; external writes can silently invalidate the count.",
        "This test-only experiment does not establish crash, concurrent-writer or production correctness.",
        "Processing excludes correctness snapshots; reference upsert and retention are separately timed and combined.",
        "Continuous throughput is measured separately without per-event snapshots, and includes one candidate fallback per trial.",
        "Both sampled selection plans are explained on the reference collection after the same upsert.",
        "Snapshots and sampled explain queries affect caches; logical client timings are not server execution times.",
      ],
      initialization: { reference: null, candidate: { ...summarize(initialization.map((item) => item.durationMs)), samples: initialization } },
      reference: { ...statistics(samples.reference), samples: samples.reference },
      candidate: { ...statistics(samples.candidate), samples: samples.candidate },
      continuousThroughput: throughputTrials,
      selectionExplain: plans,
    };
  } finally {
    try { if (db) await dropMongoTestDatabase(db); } finally { await client.close(); }
  }
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Exact-count retention experiment failed:", error);
    process.exitCode = 1;
  });
}
