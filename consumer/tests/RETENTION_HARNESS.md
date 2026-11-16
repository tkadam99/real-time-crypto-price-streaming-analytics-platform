# Strict retention harness

This is a test-only comparison, not a production change or a recommendation.
Use a **disposable MongoDB deployment**, not the application's MongoDB instance.
The account must be able to create and drop databases and indexes. Set
`MONGO_INTEGRATION_URI` to its MongoDB connection URI. These programs always
generate a UUID-prefixed database name; they never use a database name in the
URI. They drop only that generated database in cleanup. A terminated process
may leave its generated `retention_harness_test_...` or
`retention_benchmark_...` database behind; inspect and remove it manually only
after confirming its identity. Do not use the production database.

From `consumer`, run:

```powershell
$env:MONGO_INTEGRATION_URI = 'mongodb://127.0.0.1:27018'
$env:KAFKA_INTEGRATION_BROKER = $null
$env:RETENTION_BENCH_WARMUP = '2'
$env:RETENTION_BENCH_TRIALS = '8'
$env:RETENTION_BENCH_SEED = '20261113'
npm test -- --runTestsByPath tests\retentionBenchmarkUtils.test.js tests\retentionHarness.mongo.integration.test.js
node tests\retentionBenchmark.js > retention-benchmark-paired.json
$LASTEXITCODE
npm test
```

The URI is an example, not a service created by this harness. If the variable
is missing, the correctness suite is skipped and the benchmark exits with an
error. The benchmark writes its JSON summary to standard output only after
successful completion and cleanup; errors go to standard error and produce a
nonzero exit code. Check `$LASTEXITCODE` before sharing the redirected file.
PowerShell output redirection can create an empty file even on failure.
Clearing the Kafka integration broker skips the suite's real-Kafka integration
tests; the full suite still includes MongoDB cleanup tests in their isolated
test databases, not the application's decision-cleanup configuration.

## Comparisons

The reference reproduces the consumer's `find({symbol})`, descending
`timestamp, receivedAt, _id`, `skip(N)`, `_id` projection and materialized-ID
`deleteMany({symbol, _id: {$in: ...}})`. It operates on stored strings, not
normalized timestamps. The hinted candidate uses exactly that query and
deletion with the existing ascending index explicitly hinted. The experimental
boundary candidate selects the first excess record and deletes a lexicographic
range through that record. It still scans past N index entries and may not be
faster. Each candidate skips deletion when no excess exists.

Equivalence tests use scalar string fields, simple collation and isolated,
single-writer operations. A separate test demonstrates that a concurrent old
insert between selection and deletion survives the reference but is removed by
the boundary candidate. Malformed or mixed BSON types, non-simple collation,
concurrent mutation and actual server/driver failure timing are not certified.
Thus the boundary candidate is **not production-equivalent** and must not be
recommended as a drop-in replacement. The hinted candidate also needs real
production-plan and index-availability analysis before any change.

Before each successful cleanup, the harness independently reads all documents
in MongoDB's stored sort order. It retains the pre-cleanup first N for the
processed symbol as the oracle, and after cleanup checks the cap, exact ordered
documents and unchanged unrelated symbols. This oracle does not use either
algorithm's deletion candidates. The integration suite also compares a
five-record recent-history query and a simplified predecessor/average.

The injected read, delete, and partial-delete failures occur at harness hook
boundaries; they are not MongoDB failpoint, network or crash tests. No cap is
required immediately after failure; the independent cap and identity checks
apply after a successful fresh invocation. Retry is not a process or Kafka
restart. Full consumer analytics, alert decisions, offset handling and recovery
are outside the scope of this harness.

## Measurement

The benchmark uses separate collections on one deployment with identical seed
data, steps and both production indexes. Targets are 100 and 10,000. Defaults
are two warm-up and eight measured trials per workload, configurable with
`RETENTION_BENCH_WARMUP` (0-10) and `RETENTION_BENCH_TRIALS` (1-50). Normal
has three steps, so the default yields 24 measured observations per algorithm
and target; each other workload has 16. The normal, duplicate, late/reinserted
and large-excess/tie workloads are unchanged. The large-excess collection also
contains one untouched ETH record.

Default setup inserts approximately 1,227,060 documents across all trial
collections and performs 540 retention operations including warm-up, plus
snapshot reads, explains, cleanup and untimed failure scenarios. Each operation
reads the entire collection before and after retention for correctness; this is
deliberate and expensive. Increasing trial counts multiplies this work. Use an
isolated deployment with sufficient storage and capacity.

Each step's algorithm order is shuffled deterministically from the seed, trial
and step. Record the seed and settings when sharing results; repeat whole runs
with different seeds to assess sensitivity to ordering. Seeded shuffling does
not guarantee balanced positions. Collections, cache, storage layout, background
load, and earlier operations can still affect measurements. Pre-operation
snapshots and sampled explains also warm data: this is not a cold-cache
experiment or an exact reproduction of production's concurrent workload.

JSON includes MongoDB version, actual index metadata, settings, individual
trial/step samples and execution order, query, delete, total retention and
simulated upsert-plus-retention wall times, simulated throughput, and measured
find/getMore/delete command and deleted-document counts. `deleteMs` is zero when
no deletion is issued; total time includes helper overhead and need not equal
the sum of query and delete times. Explain, setup, upserts and verification are
excluded from retention command counts. Nearest-rank p95 is based on the
reported sample count and is unstable with small samples. Samples within a
trial are not independent.

Each measured sample's snapshot and `finalSnapshot` contain `collectionCount`
for every symbol combined and `symbols` with per-symbol counts and ordered
identity hashes. For example, 10,000 BTC plus one
untouched ETH is collection count 10,001, not a BTC cap violation. Validation
occurs after every successful operation, not just on the final snapshot.
Failure snapshots report post-failure and post-retry states separately. A
mismatch aborts with an error and nonzero exit rather than emitting a successful
JSON summary.

For each measured trial's first step, selection explain reports recognized
winning-plan stages, index names/key patterns, scan directions, blocking SORT
status, raw winning plans, and execution statistics; `planComparisons` flags
observed differences in the stage structure, scan details and counts. The
comparison does not assert equality of every planner property.
Missing or unrecognized plan structures are explicitly marked uninterpretable
with warnings. These sampled explains are not plans for every operation and
MongoDB's explain planning can differ from cached execution. Explain statistics
cover selection, not delete execution. The benchmark does not prove that equal
keys examined imply equal cost, or that a latency difference is a reproducible
production speedup. Evaluate repeated paired results and plans before proposing
any production change.
