// Standalone diagnostic; never imports or starts the consumer.
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { MongoClient } = require("mongodb");
const {
  INDEXES, algorithms, boundaryQuery, createIndexes, event,
  ordered, referenceQuery, snapshotSummary, upsertEvent, validateRetention,
} = require("./retentionHarness");
const { orderFor, extractPlan, comparePlans } = require("./retentionBenchmarkUtils");

const uri = process.env.MONGO_INTEGRATION_URI;
if (!uri) {
  console.error("Set MONGO_INTEGRATION_URI to a disposable MongoDB deployment before running this benchmark.");
  process.exitCode = 1;
} else {
  main().catch((error) => {
    console.error("Retention benchmark failed:", error);
    process.exitCode = 1;
  });
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    averageMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

function workloads(target) {
  const base = Array.from({ length: target }, (_, i) => event("BTC-USD", i));
  const newest = event("BTC-USD", target + 1);
  return [
    { name: "normal", seed: base, steps: [newest, event("BTC-USD", target + 2), event("BTC-USD", target + 3)] },
    { name: "duplicate", seed: base, steps: [base[target - 1], base[target - 1]] },
    { name: "late-and-reinserted", seed: base, steps: [event("BTC-USD", -2), event("BTC-USD", -2)] },
    {
      name: "large-excess-and-ties",
      seed: [...base, ...Array.from({ length: 250 }, (_, i) => event("BTC-USD", target + i, {
        timestamp: "2025-02-01T00:00:00.000Z",
        receivedAt: "2025-02-01T00:00:00.000Z",
      })), event("ETH-USD", 1)],
      steps: [event("BTC-USD", target + 300), event("BTC-USD", -3)],
    },
  ];
}

async function explain(collection, name, target) {
  const query = name === "boundary"
    ? boundaryQuery(collection, "BTC-USD", target)
    : referenceQuery(collection, "BTC-USD", target, name === "hinted");
  return extractPlan(await query.explain("executionStats"));
}

function integerSetting(name, fallback, minimum, maximum) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

async function failureCases(collections, names) {
  const cases = [];
  for (const failure of ["read", "delete", "partial"]) {
    const seed = [...Array.from({ length: 10 }, (_, index) => event("BTC-USD", index)), event("ETH-USD", 1)];
    const originals = {};
    for (const name of names) {
      const collection = collections[name];
      await collection.deleteMany({});
      await collection.insertMany(seed);
      originals[name] = await ordered(collection);
      const expectedMessage = `injected ${failure}`;
      const hooks = failure === "read"
        ? { beforeRead: async () => { throw new Error(expectedMessage); } }
        : { beforeDelete: async (filter) => {
            if (failure === "partial") {
              const ids = await collection.find(filter).sort({ _id: 1 }).limit(2).project({ _id: 1 }).toArray();
              await collection.deleteMany({ _id: { $in: ids.map((item) => item._id) } });
            }
            throw new Error(expectedMessage);
          } };
      let failed = false;
      try {
        await algorithms[name](collection, "BTC-USD", 3, hooks);
      } catch (error) {
        if (error.message !== expectedMessage) throw error;
        failed = true;
      }
      if (!failed) throw new Error(`${name} did not propagate ${failure} failure`);
    }
    for (const phase of ["afterFailure", "afterFreshInvocation"]) {
      if (phase === "afterFreshInvocation") {
        for (const name of names) {
          const before = await ordered(collections[name]);
          await algorithms[name](collections[name], "BTC-USD", 3);
          const after = await ordered(collections[name]);
          validateRetention(before, after, "BTC-USD", 3, `${name} ${failure} retry`);
          validateRetention(originals[name], after, "BTC-USD", 3, `${name} ${failure} recovery`);
        }
      }
      const reference = await ordered(collections.reference);
      const snapshots = {};
      for (const name of names) {
        const actual = await ordered(collections[name]);
        if (JSON.stringify(actual) !== JSON.stringify(reference)) {
          throw new Error(`Failure recovery mismatch: ${name}, failure=${failure}, phase=${phase}`);
        }
        if (phase === "afterFailure" && JSON.stringify(actual.filter((doc) => doc.symbol !== "BTC-USD")) !==
            JSON.stringify(originals[name].filter((doc) => doc.symbol !== "BTC-USD"))) {
          throw new Error(`Unrelated symbols changed after failure: ${name}, failure=${failure}`);
        }
        snapshots[name] = snapshotSummary(actual);
      }
      cases.push({ failure, phase, snapshots });
    }
  }
  return cases;
}

async function main() {
  const warmupTrials = integerSetting("RETENTION_BENCH_WARMUP", 2, 0, 10);
  const measuredTrials = integerSetting("RETENTION_BENCH_TRIALS", 8, 1, 50);
  const seed = process.env.RETENTION_BENCH_SEED === undefined ? "20261113" : process.env.RETENTION_BENCH_SEED;
  if (!seed || seed.length > 128) throw new Error("RETENTION_BENCH_SEED must contain 1 to 128 characters");
  const client = new MongoClient(uri, { monitorCommands: true });
  const dbName = `retention_benchmark_${randomUUID().replace(/-/g, "")}`;
  let db;
  let counter = null;
  client.on("commandStarted", (command) => {
    if (counter && ["find", "getMore", "delete"].includes(command.commandName)) {
      counter[command.commandName] += 1;
    }
  });
  try {
    await client.connect();
    db = client.db(dbName);
    const version = await db.admin().command({ buildInfo: 1 });
    const names = Object.keys(algorithms);
    const collections = {};
    for (const name of names) {
      collections[name] = await db.createCollection(name, { collation: { locale: "simple" } });
      await createIndexes(collections[name]);
    }
    const output = {
      database: dbName, mongodbVersion: version.version,
      settings: { targets: [100, 10000], warmupTrials, measuredTrials, seed, requestedIndexes: INDEXES, actualIndexes: await collections.reference.listIndexes().toArray(), collation: "simple" },
      note: "Test-only measurements do not prove a production speedup. Explain runs before the first measured step and can affect cache; query and deletion timings are client wall time.",
      boundaryWarning: "The boundary candidate is non-equivalent under concurrent old insertion and is not production eligible.",
      injectedFailureRecovery: await failureCases(collections, names),
      results: [],
    };
    for (const target of output.settings.targets) {
      for (const workload of workloads(target)) {
        const buckets = Object.fromEntries(names.map((name) => [name, {
          samples: [], commands: { find: 0, getMore: 0, delete: 0 },
          deletedDocuments: 0, plans: [], finalSnapshot: null,
        }]));
        const planComparisons = [];
        for (let trial = -warmupTrials; trial < measuredTrials; trial++) {
          for (const name of names) {
            await collections[name].deleteMany({});
            await collections[name].insertMany(workload.seed);
          }
          for (let step = 0; step < workload.steps.length; step++) {
            const executionOrder = orderFor(seed, trial, step, names);
            const afterByName = {};
            const stepPlans = {};
            for (const name of executionOrder) {
              const collection = collections[name];
              const start = performance.now();
              await upsertEvent(collection, workload.steps[step]);
              const afterUpsert = performance.now();
              const before = await ordered(collection);
              if (trial >= 0 && step === 0) {
                stepPlans[name] = await explain(collection, name, target);
                buckets[name].plans.push({ trial, ...stepPlans[name] });
              }
              counter = { find: 0, getMore: 0, delete: 0 };
              const retentionStart = performance.now();
              const timings = { queryMs: 0, deleteMs: 0 };
              let result;
              try {
                result = await algorithms[name](collection, "BTC-USD", target, { timings });
              } finally {
                const elapsed = performance.now() - retentionStart;
                if (trial >= 0) {
                  buckets[name].samples.push({
                    trial, step, executionOrder, queryMs: timings.queryMs, deleteMs: timings.deleteMs,
                    retentionMs: elapsed, simulatedProcessingMs: afterUpsert - start + elapsed,
                  });
                  for (const key of Object.keys(counter)) buckets[name].commands[key] += counter[key];
                }
                counter = null;
              }
              if (trial >= 0) buckets[name].deletedDocuments += result.deleted;
              const after = await ordered(collection);
              validateRetention(before, after, "BTC-USD", target, `${name}, target=${target}, workload=${workload.name}, trial=${trial}, step=${step}`);
              if (trial >= 0) {
                buckets[name].samples[buckets[name].samples.length - 1].snapshot = snapshotSummary(after);
              }
              afterByName[name] = after;
            }
            if (trial >= 0 && step === 0) planComparisons.push({ trial, ...comparePlans(stepPlans.reference, stepPlans.hinted) });
            const reference = afterByName.reference;
            for (const name of names) {
              const actual = afterByName[name];
              if (JSON.stringify(actual) !== JSON.stringify(reference)) {
                throw new Error(`Identity/order/content mismatch: ${name}, target=${target}, workload=${workload.name}, trial=${trial}, step=${step}`);
              }
              if (trial >= 0 && step === workload.steps.length - 1) {
                buckets[name].finalSnapshot = snapshotSummary(actual);
              }
            }
          }
        }
        for (const name of names) {
          const bucket = buckets[name];
          const totalProcessingMs = bucket.samples.reduce((sum, value) => sum + value.simulatedProcessingMs, 0);
          output.results.push({
            target, workload: workload.name, algorithm: name,
            retentionLatency: stats(bucket.samples.map((item) => item.retentionMs)),
            queryLatency: stats(bucket.samples.map((item) => item.queryMs)),
            deleteLatency: stats(bucket.samples.map((item) => item.deleteMs)),
            simulatedProcessingLatency: stats(bucket.samples.map((item) => item.simulatedProcessingMs)),
            simulatedEventsPerSecond: bucket.samples.length * 1000 / totalProcessingMs,
            commands: bucket.commands, deletedDocuments: bucket.deletedDocuments,
            samples: bucket.samples, explainSamples: bucket.plans,
            planComparisons, finalSnapshot: bucket.finalSnapshot, correctnessFailures: 0,
          });
        }
      }
    }
    // Print only once cleanup succeeds.
    await db.dropDatabase();
    db = null;
    await client.close();
    console.log(JSON.stringify(output, null, 2));
  } finally {
    try { if (db) await db.dropDatabase(); } finally { await client.close(); }
  }
}
