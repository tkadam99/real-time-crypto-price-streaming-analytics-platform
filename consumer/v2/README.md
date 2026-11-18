# V2 event contract

This isolated contract is not connected to the existing pipeline. An envelope
contains `version: 1`, the original `symbol`, `price` and `timestamp`, and
`source: { clusterId, topicGenerationId, topic, partition, offset }`. The offset
is a canonical nonnegative decimal string in Kafka's signed 64-bit range; it is
never converted to a JavaScript number. Timestamp validation follows the existing
consumer's `Date.parse` acceptance.

The idempotency key is the JSON serialization of the ordered source-identity
tuple. Cluster and topic-generation IDs must identify the actual source and
topic incarnation. Relay delivery may duplicate a source event, and its v2
Kafka offset is not the original identity.

Partitioning version 1 explicitly maps `BTC-USD` to partition 0, `ETH-USD` to
partition 1, and `SOL-USD` to partition 2. Exactly six Kafka partitions are
required; partitions 3–5 are initially unused. Adding symbols or changing this
mapping requires a deliberate versioned migration, including coordinated topic
and partitioner changes.
