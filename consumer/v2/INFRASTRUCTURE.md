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
docker compose -p crypto-v2 -f docker-compose.v2.yml up -d
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
docker compose -p crypto-v2 -f docker-compose.v2.yml ps
docker compose -p crypto-v2 -f docker-compose.v2.yml logs v2-mongo-init v2-topic-init
docker compose -p crypto-v2 -f docker-compose.v2.yml exec v2-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server v2-kafka:29092 --describe --topic crypto-prices-v2
docker compose -p crypto-v2 -f docker-compose.v2.yml exec v2-mongodb mongosh --quiet --eval "rs.status()"
```

Confirm both init services exited successfully, the broker and MongoDB are
healthy, the topic reports six partitions with replication factor one, and
`rs.status()` reports `rs-v2` with one `PRIMARY` member.

## Host-only V2 Kafka relay

The relay runs on the Windows host, not in Compose. It uses separate KafkaJS
clients for V1 at `127.0.0.1:9092` and V2 at `127.0.0.1:19092`. The existing V1
container must be running with the Docker name `kafka`; before starting its
consumer, the relay uses the Docker CLI for a bounded, shell-disabled,
read-only topic-ID preflight. Before connecting the V1 consumer or V2 producer,
the relay verifies the V1 topic ID and cluster ID, then verifies the V2 cluster
ID and `crypto-prices-v2` metadata (exactly six partitions, with partitions
0-2 having leaders). It uses separate V1 and V2 Kafka admin clients and
disconnects both after verification, including on failure or cancellation.

Set the mandatory V1 source and V2 destination identifiers in PowerShell:

```powershell
$env:V1_SOURCE_CLUSTER_ID = "0jtOiYT4QmShqPK0HjBpQA"
$env:V1_SOURCE_TOPIC_GENERATION_ID = "9ShfnW90Th-vI4A2Jl1O4Q"
$env:V2_DESTINATION_CLUSTER_ID = "4L6g3nShT-eMCtK--X86sw"
```

From the repository root, start the relay explicitly:

```powershell
node consumer/v2/relayMain.js
```

The relay uses group `crypto-v2-relay-group`. SIGINT and SIGTERM trigger
graceful shutdown; no relay starts when configuration or any of the three
identity and destination checks fails.

## Stop and persistence

```powershell
docker compose -p crypto-v2 -f docker-compose.v2.yml down
```

This stops/removes only this Compose project's containers and network. It keeps
the project-scoped Kafka and MongoDB named volumes so data survives a stop/start.
Do not append `--volumes`/`-v` for routine cleanup: that would erase V2 data.
The host ports are loopback-only and separate from the V1 ports.
