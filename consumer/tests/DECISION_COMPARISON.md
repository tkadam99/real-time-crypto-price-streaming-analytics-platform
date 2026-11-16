# Isolated durable decision comparison

This is a test-only experiment, not a production replacement. Use a disposable
MongoDB deployment, never the application's database or its live deployment.
The URI must permit creating and dropping databases and creating indexes.
The suite and benchmark generate UUID-named databases and drop only those
databases. An interrupted process can leave a `decision_comparison_test_...`
or `decision_benchmark_...` database behind; inspect its identity before any
manual cleanup. Neither tool starts Kafka or invokes production cleanup.

From `consumer`:

```powershell
$env:MONGO_INTEGRATION_URI = 'mongodb://127.0.0.1:27018'
$env:DECISION_BENCH_WARMUP = '1'
$env:DECISION_BENCH_TRIALS = '4'
$env:DECISION_BENCH_SIZE = '40'
$env:DECISION_BENCH_SEED = '20261113'
npm test -- --runTestsByPath tests\decisionComparisonHarness.test.js tests\decisionComparison.mongo.integration.test.js
node tests\decisionComparisonBenchmark.js > decision-benchmark.json
$LASTEXITCODE
```

The URI is an example, not a deployment created by these tools. Without it,
MongoDB integration tests are skipped and the benchmark exits nonzero. JSON is
printed only after successful checks and database cleanup. Check the exit code:
PowerShell redirection may create an empty file on failure. The output excludes
the URI to avoid exposing credentials.

## Production reference

The harness uses the actual `createAlertDecisionStore` as its reference. Its
caller first looks up the durable record by `_id` built from topic, partition
and offset. On a miss, the consumer reads legacy raw history and uses its
original decision, including explicit null, if present; otherwise it calculates
a decision from the tracker. The harness models this decision branch with a
supplied candidate, not the tracker itself. It does not import the consumer.

`findOneAndUpdate` uses `$setOnInsert`, upsert and the returned post-image.
Existing decisions are not overwritten. Duplicate-key errors trigger a read of
the winner; missing winners and other errors propagate. Returned documents are
validated for positive/null decisions, identity, group ownership and BSON Long
offsets. Legacy decision documents with no cleanup metadata are accepted with
a warning; partial metadata or conflicting ownership fails. The unique `_id`
does not include the group. The additional nonunique
`decision_group_topic_partition_offset` index supports reconciliation.

The production consumer awaits the decision before raw, metrics and alert
writes. KafkaJS uses automatic offset management. Reconciliation reads
committed offsets and samples decisions; cleanup defaults to disabled. The
harness does not change this configuration. Its deletion tests model a
decision disappearing, not the real reconciliation/cleanup implementation.
Deleting a durable decision and its legacy raw record can make the original
decision unrecoverable on replay.

Neither reference nor experiment sets a write concern. They use the same
MongoClient and URI, preserving the configured/inherited concern; no concern is
added or changed. The benchmark reports the client-level value when available
and explicitly marks the server default unknown. It does not prove effective
replication durability. Use a deployment whose concern is acknowledged. Do not
compare runs using different URI write-concern or retry settings.

## Experimental behavior and known differences

The experimental path uses the same identity, input validation, `$setOnInsert`,
unique `_id` and metadata, followed by awaited `updateOne`. It returns its local
document only after an acknowledged result reports exactly one insertion with
the expected ID and no match. It checks a BSON round trip to reject noncanonical
local documents rather than assuming serialization preserves them. For a match
or duplicate-key error it reads and validates the stored winner using the
production store; a missing matched winner is an explicit error and a missing
duplicate winner propagates the original duplicate error.

**The candidate is not generally equivalent.** If the matched document is
deleted after the update but before its follow-up read, the reference can return
its already captured post-image while the experiment fails. A new insert can
also be deleted before the experiment returns its local document; neither
operation protects against later deletion. The test-only experiment rejects
some inputs the reference accepts, including values that do not round-trip
through BSON unchanged. The round-trip check itself does not account for every
custom serialization option, encryption, server-side transformation or
concurrent mutation. These cases prevent a blanket production recommendation.

## Workloads and acceptance

Defaults are one warm-up and four measured trials, 40 identities per workload
and variant. Configure `DECISION_BENCH_WARMUP` (0-10),
`DECISION_BENCH_TRIALS` (1-30), `DECISION_BENCH_SIZE` (2-500), and
`DECISION_BENCH_SEED` (1-128 characters). Each of five workloads is reset to
identical data for both algorithms: new, replay, 50/50 mixed, legacy migration,
and concurrent competing values with different groups. Algorithm order is
seeded per workload/trial; it is reproducible but not guaranteed balanced.
Default total is 1,920 measured decision operations including the expected
320 ownership-conflict failures, plus 480 warm-up operations and setup/reads.
The concurrent scenario invokes `insertOriginal` directly to provoke the race;
other workloads use the modeled lookup/legacy/upsert sequence.

For the scoped workloads, each successful returned result must match the
persisted document, each expected ownership conflict must fail, and all
unexpected failures abort with nonzero exit. The integration suite checks
replay, positive/null decisions, legacy migration, large offsets, ownership
and metadata errors, concurrent winners, duplicate errors, injected read/write
and ambiguous-acknowledgment failures, and retry. Injected ambiguous writes
perform a real write and then throw locally; they are not actual network
ambiguity. The candidate must not be considered equivalent solely because
these tests pass or final documents match.

JSON records individual success and expected-conflict samples, command counts,
failure/conflict counts, success throughput, and client-side read, write, total,
and residual non-database time. Residual time includes validation, BSON
round-trip, JavaScript and instrumentation overhead; it is **not isolated
validation time**. Statistics exclude failed operations; conflict samples are
separate. Throughput uses the measured trial wall time and counts successful
operations, so the concurrent scenario includes time spent on expected
conflicts. Setup and verification commands are excluded. Performance must be
assessed over repeated runs, seeds and comparable deployment conditions; these
small samples and p95 are descriptive, not proof of a production gain.

The harness does not reproduce real Kafka rebalances or commits, process crashes,
network partitions, full downstream metrics/alerts, the production workload or
topology, and actual reconciliation scheduling. The live 3.13 ms timing also
includes lookups and decision calculation, not just the write. A faster
isolated write therefore need not improve whole-consumer throughput.
