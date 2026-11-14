// Standalone diagnostic; never imports or starts the consumer.
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { MongoClient } = require("mongodb");
const {
  INDEXES, algorithms, boundaryQuery, createIndexes, event, olderThan,
  ordered, referenceQuery, signature, upsertEvent,
} = require("./retentionHarness");

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
  const plan = await query.explain("executionStats");
  const result = {
    selection: {
      keysExamined: plan.executionStats.totalKeysExamined,
      documentsExamined: plan.executionStats.totalDocsExamined,
      returned: plan.executionStats.nReturned,
    },
  };
  if (name === "boundary") {
    const [cutoff] = await boundaryQuery(collection, "BTC-USD", target).toArray();
    if (cutoff) {
      const proxy = await collection.find(olderThan("BTC-USD", cutoff))
        .project({ _id: 1 }).explain("executionStats");
      result.deletePredicateFindProxy = {
        keysExamined: proxy.executionStats.totalKeysExamined,
        documentsExamined: proxy.executionStats.totalDocsExamined,
        returned: proxy.executionStats.nReturned,
      };
    }
  }
  return result;
}

async function failureCases(collections, names) {
  const cases = [];
  for (const failure of ["read", "delete", "partial"]) {
    const seed = Array.from({ length: 10 }, (_, index) => event("BTC-USD", index));
    for (const name of names) {
      const collection = collections[name];
      await collection.deleteMany({});
      await collection.insertMany(seed);
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
        for (const name of names) await algorithms[name](collections[name], "BTC-USD", 3);
      }
      const reference = await ordered(collections.reference);
      const snapshots = {};
      for (const name of names) {
        const actual = await ordered(collections[name]);
        if (JSON.stringify(actual) !== JSON.stringify(reference)) {
          throw new Error(`Failure recovery mismatch: ${name}, failure=${failure}, phase=${phase}`);
        }
        snapshots[name] = { count: actual.length, identitySha256: signature(actual) };
      }
      cases.push({ failure, phase, snapshots });
    }
  }
  return cases;
}

async function main() {
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
      settings: { targets: [100, 10000], warmupTrials: 1, measuredTrials: 3, requestedIndexes: INDEXES, actualIndexes: await collections.reference.listIndexes().toArray(), collation: "simple" },
      note: "Latency covers the test-only upsert and retention, not the complete historical consumer. Explain statistics are sampled before the first step; delete predicate find is a proxy, not a delete execution plan.",
      injectedFailureRecovery: await failureCases(collections, names),
      results: [],
    };
    for (const target of output.settings.targets) {
      for (const workload of workloads(target)) {
        const buckets = Object.fromEntries(names.map((name) => [name, {
          retentionMs: [], processingMs: [], commands: { find: 0, getMore: 0, delete: 0 },
          deletedDocuments: 0, explain: [], finalCount: null, finalIdentitySha256: null, correctnessFailures: 0,
        }]));
        for (let trial = -1; trial < output.settings.measuredTrials; trial++) {
          for (const name of names) {
            await collections[name].deleteMany({});
            await collections[name].insertMany(workload.seed);
          }
          for (let step = 0; step < workload.steps.length; step++) {
            for (const name of names) {
              const collection = collections[name];
              const start = performance.now();
              await upsertEvent(collection, workload.steps[step]);
              const afterUpsert = performance.now();
              if (trial >= 0 && step === 0) buckets[name].explain.push(await explain(collection, name, target));
              counter = { find: 0, getMore: 0, delete: 0 };
              const retentionStart = performance.now();
              let result;
              try {
                result = await algorithms[name](collection, "BTC-USD", target);
              } finally {
                const elapsed = performance.now() - retentionStart;
                if (trial >= 0) {
                  buckets[name].retentionMs.push(elapsed);
                  // Exclude the deliberately separate explain from processing time.
                  buckets[name].processingMs.push(afterUpsert - start + elapsed);
                  for (const key of Object.keys(counter)) buckets[name].commands[key] += counter[key];
                }
                counter = null;
              }
              if (trial >= 0) buckets[name].deletedDocuments += result.deleted;
            }
            const reference = await ordered(collections.reference);
            for (const name of names) {
              const actual = await ordered(collections[name]);
              if (JSON.stringify(actual) !== JSON.stringify(reference)) {
                buckets[name].correctnessFailures++;
                throw new Error(`Identity/order/content mismatch: ${name}, target=${target}, workload=${workload.name}, trial=${trial}, step=${step}`);
              }
              if (trial >= 0 && step === workload.steps.length - 1) {
                buckets[name].finalCount = actual.length;
                buckets[name].finalIdentitySha256 = signature(actual);
              }
            }
          }
        }
        for (const name of names) {
          const bucket = buckets[name];
          const totalProcessingMs = bucket.processingMs.reduce((sum, value) => sum + value, 0);
          output.results.push({
            target, workload: workload.name, algorithm: name,
            retentionLatency: stats(bucket.retentionMs), simulatedProcessingLatency: stats(bucket.processingMs),
            simulatedEventsPerSecond: bucket.processingMs.length * 1000 / totalProcessingMs,
            commands: bucket.commands, deletedDocuments: bucket.deletedDocuments,
            explainSamples: bucket.explain, finalCount: bucket.finalCount,
            finalIdentitySha256: bucket.finalIdentitySha256, correctnessFailures: bucket.correctnessFailures,
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
