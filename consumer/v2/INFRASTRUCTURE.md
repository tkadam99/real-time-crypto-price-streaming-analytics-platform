# Isolated V2 infrastructure

This stack is independent of the V1 `docker-compose.yml`: it has its own Compose
project (`crypto-v2`), network, Kafka broker, replica-set MongoDB and named
volumes, automatically scoped to the project. It does not start application workers. Kafka topic initialization
creates `crypto-prices-v2` with six partitions and replication factor one. If
the topic already exists with a different partition count or replication factor,
initialization fails without changing it.

## Start

From the repository root:

```powershell
docker compose -f docker-compose.v2.yml up -d
```

Kafka host clients use `127.0.0.1:19092`; future V2 containers on this Compose
network use `v2-kafka:29092`.

Before Kafka starts, the one-shot `v2-kafka-data-init` service runs as root
against only the V2 Kafka named volume and sets its data directory ownership
to UID/GID `1000:1000`. It changes only the directory itself; existing contents
are neither modified nor recursively re-owned. This prepares a fresh volume
without deleting, formatting or resetting data.

V2 containers use this MongoDB URI:

```text
mongodb://v2-mongodb:27017/crypto_analytics_v2?replicaSet=rs-v2
```

The replica set advertises `v2-mongodb:27017`, which resolves on the Compose
network but generally not from a Windows host. A host client can use the optional
loopback-published port with direct connection:

```text
mongodb://127.0.0.1:27019/crypto_analytics_v2?directConnection=true
```

Direct connection bypasses replica-set member discovery. Verify MongoDB driver
transaction support using this URI before relying on transactions from host-run
applications; prefer running those applications inside the V2 network.

## Verify

```powershell
docker compose -f docker-compose.v2.yml ps
docker compose -f docker-compose.v2.yml logs v2-mongo-init v2-topic-init
docker compose -f docker-compose.v2.yml exec v2-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server v2-kafka:29092 --describe --topic crypto-prices-v2
docker compose -f docker-compose.v2.yml exec v2-mongodb mongosh --quiet --eval "rs.status()"
```

Confirm both init services exited successfully, the broker and MongoDB are
healthy, the topic reports six partitions with replication factor one, and
`rs.status()` reports `rs-v2` with one `PRIMARY` member.

## Host-only V2 Kafka relay

The relay runs on the Windows host, not in Compose. It uses separate KafkaJS
clients for V1 at `127.0.0.1:9092` and V2 at `127.0.0.1:19092`. The existing V1
container must be running with the Docker name `kafka`; before starting its
consumer, the relay uses the Docker CLI for a bounded, shell-disabled,
read-only topic-ID preflight. Both the V1 cluster ID and topic-generation ID
must match before the relay consumer connects or subscribes.

Set the mandatory V1 source identifiers in PowerShell:

```powershell
$env:V1_SOURCE_CLUSTER_ID = "0jtOiYT4QmShqPK0HjBpQA"
$env:V1_SOURCE_TOPIC_GENERATION_ID = "9ShfnW90Th-vI4A2Jl1O4Q"
```

From the repository root, start the relay explicitly:

```powershell
node consumer/v2/relayMain.js
```

The relay uses group `crypto-v2-relay-group`. SIGINT and SIGTERM trigger
graceful shutdown; no relay starts when configuration or either identity check
fails.

## Stop and persistence

```powershell
docker compose -f docker-compose.v2.yml down
```

This stops/removes only this Compose project's containers and network. It keeps
the project-scoped Kafka and MongoDB named volumes so data survives a stop/start.
Do not append `--volumes`/`-v` for routine cleanup: that would erase V2 data.
The host ports are loopback-only and separate from the V1 ports.
