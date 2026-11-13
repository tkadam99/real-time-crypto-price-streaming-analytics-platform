# Kafka tail and consumer progress diagnostic

From the `consumer` directory, run `npm run diagnose:kafka` for a single
snapshot and tail sample, or `npm run diagnose:kafka -- --observe` to add an
approximately 60-second comparison. Kafka must already be running. `KAFKA_BROKER`
and `KAFKA_TOPIC` use the same environment variables and defaults as the
consumer; a `consumer/.env` file is loaded if present. The application group
is fixed to `crypto-analytics-group`, matching the current source.

Output is JSON lines. `baseline` reports partition low, end, committed and lag
offsets as decimal strings; null means there is no valid committed offset and
`commitStatus` distinguishes missing from malformed values.
Negative lag indicates an inconsistent or rewound snapshot, not zero lag.
`tail-sample` reports up to five records in the last five offset positions per
partition as of the baseline. Its market timestamp comes from the producer's
JSON `timestamp` field (Coinbase ticker `time`). Kafka's message timestamp is
reported separately. Missing, invalid and future timestamps are identified;
age is signed milliseconds at sampling time. Payloads and connection settings
are not printed.

An `observation` contains the second snapshot, approximate elapsed time,
end-offset advancement, committed-offset advancement, offsets per second and
net lag change. Values can be negative after resets or truncation. These are
offset changes, not exact event counts or processing throughput: offsets can
have gaps, commits can be batched, and the topic and group reads are not atomic.
The observation spans approximately 60 seconds between snapshots, with timing
estimated from their midpoints.

The sampler uses a random temporary group, disables auto-commit, and seeks only
that group. It never writes application offsets or accesses MongoDB. Creating
and joining a temporary group is still broker activity and may leave group
metadata until Kafka expires it. The diagnostic requires the corresponding
topic/group read and describe permissions. It refuses more than 32 partitions.
Sampling stops after 15 seconds once the consumer has joined; connection,
group-join and shutdown time are additional. A timeout or `complete: false`
means the sample is partial, which can occur with compacted/deleted offsets,
retention races or an unavailable partition. It does not scan backwards to
replace missing offsets; even a complete range can contain gaps. KafkaJS's
default read-committed isolation can also hide uncommitted transactional
records. Broker requests and shutdown can take additional
time. Interrupt with Ctrl+C and allow cleanup to finish; forced termination may
leave the temporary group until its session expires.
