// Isolated test-only benchmark. Never starts the historical consumer.
const { randomUUID, createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { MongoClient, Long } = require("mongodb");
const { EMPTY, GROUP, POSITIVE, decide, experimental, idOf, identity, reference, setupIndexes, timedCollection } = require("./decisionComparisonHarness");

function setting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return Number(raw);
}

function order(seed, workload, trial) {
  return ["reference", "experimental"].sort((a, b) => {
    const rank = (name) => createHash("sha256").update(JSON.stringify([seed, workload, trial, name])).digest("hex");
    const left = rank(a);
    const right = rank(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function stats(values) {
  if (!values.length) return { count: 0, averageMs: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

async function main() {
  const uri = process.env.MONGO_INTEGRATION_URI;
  if (!uri) throw new Error("Set MONGO_INTEGRATION_URI to a disposable MongoDB deployment.");
  const warmup = setting("DECISION_BENCH_WARMUP", 1, 0, 10);
  const trials = setting("DECISION_BENCH_TRIALS", 4, 1, 30);
  const size = setting("DECISION_BENCH_SIZE", 40, 2, 500);
  const seed = process.env.DECISION_BENCH_SEED === undefined ? "20261113" : process.env.DECISION_BENCH_SEED;
  if (!seed || seed.length > 128) throw new Error("DECISION_BENCH_SEED must contain 1 to 128 characters.");
  const client = new MongoClient(uri, { monitorCommands: true });
  if (client.writeConcern && client.writeConcern.w === 0) {
    throw new Error("Unacknowledged writes are not supported by this comparison.");
  }
  const dbName = `decision_benchmark_${randomUUID().replace(/-/g, "")}`;
  let db, activeCounts = null;
  client.on("commandStarted", (event) => {
    if (activeCounts && ["find", "findAndModify", "update"].includes(event.commandName)) {
      activeCounts[event.commandName]++;
    }
  });
  try {
    await client.connect();
    db = client.db(dbName);
    const variants = { reference, experimental };
    const collections = {};
    for (const name of Object.keys(variants)) {
      collections[name] = { decisions: db.collection(`${name}_decisions`), raw: db.collection(`${name}_raw`) };
      await setupIndexes(collections[name].decisions);
    }
    const metadata = await db.admin().command({ buildInfo: 1 });
    const writeConcern = client.writeConcern;
    const output = {
      database: dbName, mongodbVersion: metadata.version,
      settings: { warmup, trials, size, seed, indexes: await collections.reference.decisions.listIndexes().toArray() },
      writeConcern: {
        clientConfigured: writeConcern ? { w: writeConcern.w, j: writeConcern.j, wtimeoutMS: writeConcern.wtimeoutMS } : null,
        serverDefault: "Not queried; effective server/cluster default is deployment-dependent.",
        note: "Both variants use the same client and inherit its write concern; none is overridden.",
      },
      warning: "Experimental update/read is non-equivalent when a matched decision is removed before its follow-up read. No production speedup or end-to-end equivalence is established.",
      workloads: [],
    };
    const names = ["new", "replay", "mixed", "legacy", "concurrent-conflict"];
    for (const workload of names) {
      const results = Object.fromEntries(Object.keys(variants).map((name) => [name, {
        samples: [], failures: [], conflicts: 0, correctnessFailures: 0,
        commands: { find: 0, findAndModify: 0, update: 0 }, measuredWallMs: 0, successes: 0,
      }]));
      for (let trial = -warmup; trial < trials; trial++) {
        const executionOrder = order(seed, workload, trial);
        for (const name of executionOrder) {
          const { decisions, raw } = collections[name];
          await decisions.deleteMany({});
          await raw.deleteMany({});
          const setupStore = variants[name](decisions);
          for (let i = 0; i < size; i++) {
            const item = identity(i);
            if (workload === "replay" || (workload === "mixed" && i % 2 === 0)) {
              await setupStore.insertOriginal(item, EMPTY);
            } else if (workload === "legacy") {
              await raw.insertOne({ _id: idOf(item), ...EMPTY });
            }
          }
          const counts = { find: 0, findAndModify: 0, update: 0 };
          const trialSamples = [];
          const trialFailures = [];
          const expectedResults = [];
          let trialConflicts = 0;
          let trialSuccesses = 0;
          const trialStart = performance.now();
          activeCounts = counts;
          try {
            for (let i = 0; i < size; i++) {
              const item = identity(i);
              const execute = async (group, proposed, concurrent) => {
                const timings = { readMs: 0, writeMs: 0 };
                const store = variants[name](timedCollection(decisions, timings), group);
                const start = performance.now();
                try {
                  const value = concurrent
                    ? await store.insertOriginal(item, proposed)
                    : await decide(store, timedCollection(raw, timings), item, proposed);
                  const totalMs = performance.now() - start;
                  return { status: "success", value, sample: {
                    trial, operation: i, group, executionOrder, readMs: timings.readMs,
                    writeMs: timings.writeMs, totalMs, nonDatabaseMs: totalMs - timings.readMs - timings.writeMs,
                  } };
                } catch (error) {
                  const totalMs = performance.now() - start;
                  return { status: "failure", error, sample: {
                    trial, operation: i, group, executionOrder, readMs: timings.readMs,
                    writeMs: timings.writeMs, totalMs, nonDatabaseMs: totalMs - timings.readMs - timings.writeMs,
                    error: error.message,
                  } };
                }
              };
              if (workload === "concurrent-conflict") {
                const outcome = await Promise.all([
                  execute(GROUP, EMPTY, true),
                  execute("decision-comparison-other", POSITIVE, true),
                ]);
                const success = outcome.filter((entry) => entry.status === "success");
                const failure = outcome.filter((entry) => entry.status === "failure");
                if (success.length !== 1 || failure.length !== 1 ||
                    !failure[0].error.message.includes("Conflicting consumer group ownership")) {
                  throw new Error(`${name} unexpected concurrent outcome at operation ${i}: ${outcome.map((x) => x.error?.message || x.status).join("; ")}`);
                }
                trialSamples.push(success[0].sample);
                trialFailures.push(failure[0].sample);
                expectedResults.push(success[0].value);
                trialSuccesses++;
                trialConflicts++;
              } else {
                const outcome = await execute(GROUP, POSITIVE, false);
                if (outcome.status !== "success") throw outcome.error;
                const expected = workload === "replay" || workload === "legacy" || (workload === "mixed" && i % 2 === 0) ? EMPTY : POSITIVE;
                if (JSON.stringify(outcome.value.alertCandidate) !== JSON.stringify(expected.alertCandidate) ||
                    outcome.value.previousPrice !== expected.previousPrice || outcome.value.percentChange !== expected.percentChange ||
                    outcome.value.groupId !== GROUP || outcome.value.offset.toString() !== item.offset) {
                  throw new Error(`${name} incorrect decision in ${workload}, operation ${i}`);
                }
                trialSamples.push(outcome.sample);
                expectedResults.push(outcome.value);
                trialSuccesses++;
              }
            }
          } finally {
            activeCounts = null;
          }
          const wallMs = performance.now() - trialStart;
          // Verify persisted winners separately from measured commands.
          for (let i = 0; i < size; i++) {
            const item = identity(i);
            const document = await decisions.findOne({ _id: idOf(item) }, { promoteLongs: false });
            if (!document || !Long.isLong(document.offset) || !isDeepStrictEqual(document, expectedResults[i])) {
              throw new Error(`${name} returned and persisted decisions differ in ${workload}, operation ${i}`);
            }
            if (workload === "concurrent-conflict") {
              const expected = document.groupId === GROUP ? EMPTY : document.groupId === "decision-comparison-other" ? POSITIVE : null;
              if (!expected || JSON.stringify(document.alertCandidate) !== JSON.stringify(expected.alertCandidate)) {
                throw new Error(`${name} invalid concurrent winner at operation ${i}`);
              }
            }
          }
          if (trial >= 0) {
            results[name].samples.push(...trialSamples);
            results[name].failures.push(...trialFailures);
            results[name].conflicts += trialConflicts;
            results[name].successes += trialSuccesses;
            results[name].measuredWallMs += wallMs;
            for (const key of Object.keys(counts)) results[name].commands[key] += counts[key];
          }
        }
      }
      for (const name of Object.keys(variants)) {
        const data = results[name];
        output.workloads.push({
          workload, algorithm: name, ...data,
          failureCount: data.failures.length,
          latency: Object.fromEntries(["totalMs", "readMs", "writeMs", "nonDatabaseMs"].map((key) => [key, stats(data.samples.map((sample) => sample[key]))])),
          successfulOperationsPerSecond: data.successes * 1000 / data.measuredWallMs,
        });
      }
    }
    await db.dropDatabase();
    db = null;
    await client.close();
    console.log(JSON.stringify(output, null, 2));
  } finally {
    try { if (db) await db.dropDatabase(); } finally { await client.close(); }
  }
}

main().catch((error) => {
  console.error("Decision benchmark failed:", error);
  process.exitCode = 1;
});
