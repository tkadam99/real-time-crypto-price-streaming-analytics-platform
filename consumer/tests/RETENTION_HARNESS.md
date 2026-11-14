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
npm test -- --runTestsByPath tests\retentionHarness.mongo.integration.test.js
node tests\retentionBenchmark.js > retention-benchmark.json
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

The correctness suite compares all documents and ordering after insertion and
pruning, and compares a five-record recent-history query and a simplified
predecessor/average calculation. The injected read, delete, and partial-delete
failures occur at harness hook boundaries; they are not MongoDB failpoint,
network or crash tests. Retry is a fresh function invocation, not a process or
Kafka restart. Full consumer analytics, alert decisions, offset handling and
recovery are outside its scope.

## Measurement

The benchmark runs the same seed data and event steps in separate collections
on one deployment, with both production indexes, one warm-up and three measured
trials at each target (100 and 10,000). It includes normal inserts, duplicate
upserts, late/reinserted records and a large excess with timestamp/receipt ties
and a second symbol. All records are compared after every step. Explain plans
are sampled before the first retention operation of each measured trial.
Untimed injected read, deletion and partial-deletion failures are also compared
before and after a fresh invocation; these do not simulate a real server crash
or process restart.

JSON includes MongoDB version, actual indexes, settings, retention and simulated
upsert-plus-retention latency (mean/p95), simulated throughput, find/getMore and
delete command counts, deleted document counts, explain keys/documents examined,
final counts and ordered identity hashes. Explain, setup, upserts and
verification are excluded from retention command counts. The boundary
delete-predicate find explain is **only a proxy**, not the delete execution
plan; reference delete execution work is not measured by the selection explain.
Counts aggregate measured trials, while explain is sampled; p95 is nearest-rank
over the small number of observed operations. This is not end-to-end consumer
latency or a substitute for isolated server-side failure and replay tests. Any
identity or ordering mismatch aborts with a nonzero exit; no speedup is assumed.
