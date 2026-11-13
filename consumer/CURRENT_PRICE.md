# Current-price consumer

The independent `npm run start:current-prices` process consumes the configured
`KAFKA_TOPIC` (default `crypto-prices`) using Kafka group
`crypto-current-price-group`. It uses `KAFKA_BROKER`, `MONGO_URI`, and `DB_NAME`
with the same defaults as the historical consumer. It is not started by the
historical consumer. Do not start it as part of tests against application data.

The consumer writes only `current_prices`. MongoDB's automatically created
unique `_id` index enforces one document per symbol; `_id` and `symbol` are the
symbol. Each document has `price`, the original `marketTimestamp`,
`marketTimeKey` (UTC ISO timestamp with exactly nine fractional digits),
`receivedAt` (BSON Date at processing), and `kafkaTopic`, `kafkaPartition`,
`kafkaOffset` (BSON Long). `receivedAt` is the winning snapshot's processing
time, not the exchange event time or a database commit timestamp.

A single atomic update pipeline replaces all fields only if the market instant
is newer. For equal instants the lexicographically greatest tuple of topic
(simple binary collation), numeric partition, and numeric offset wins. Equal
identity and timestamp is first-write-wins, even if a duplicate's payload
differs. An older replay never refreshes `receivedAt`. The Kafka tuple provides
a deterministic tie-breaker, not a global chronological ordering across
partitions. A duplicate-key race on `_id` is retried atomically without upsert;
other write errors propagate. The collection is owned by this projection and
must not be populated with incompatible documents or indexes.
Writes require MongoDB acknowledgement with `w: 1`; this is not a guarantee of
majority durability.

Timestamps must be ISO 8601 with a timezone and zero to nine fractional digits,
valid calendar fields, and at most 30 seconds in the future relative to the
consumer clock. Precision beyond nanoseconds is rejected rather than truncated.
Input events also require a supported symbol and finite positive numeric price.
Malformed event payloads are logged and skipped as permanent input errors;
invalid Kafka identity and operational errors are logged and thrown so the
record is not acknowledged as successfully processed. Clocks should be
synchronized: excessive clock skew can reject legitimate future events or
admit a future timestamp that temporarily blocks later events.

Partitions without a group offset start at the tail. Existing valid offsets
resume normally. On first startup, prices remain absent until each symbol has a
new valid event. If the process fails before the first offset commit, the next
startup may begin at a newer tail and omit intervening events from this
latest-value view. KafkaJS may also reset out-of-range offsets to the
subscription default, and expired offsets can be treated as missing; consult
KafkaJS warning logs and monitor the group. These are not guarantees of
continuous history or bounded freshness. No historical-group offsets are
accessed. Successful persistence precedes callback completion and normal
automatic commits, so a crash can replay a snapshot without regressing it.

SIGINT and SIGTERM stop and disconnect Kafka before closing MongoDB. Shutdown is
bounded to 15 seconds; a timeout exits unsuccessfully and unfinished records
may replay. Database or broker failures can leave snapshots stale. This process
does not modify historical events, metrics, alerts, decisions, or retention,
and does not expose a new API or update the dashboard.

The optional integration tests use `MONGO_INTEGRATION_URI` and, for Kafka,
`KAFKA_INTEGRATION_BROKER`. They create and delete only their own UUID-named
test database, topic, and groups. Run them only against environments where
those disposable resources may safely be created and removed.
