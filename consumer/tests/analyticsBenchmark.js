// Run only on independently verified disposable infrastructure:
// RUN_DISPOSABLE_ANALYTICS_BENCHMARK=true ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true
// KAFKA_INTEGRATION_BROKER=<loopback:port> MONGO_INTEGRATION_URI=<loopback URI>
// node tests/analyticsBenchmark.js
// Loopback addresses and opt-in flags do not prove that infrastructure is disposable.
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const {
  createKafkaConnectionOptions,
  createKafkaTestResources,
  getKafkaIntegrationBroker,
} = require("../../test-utils/kafkaIntegrationSafety");
const {
  createMongoTestDatabase,
  dropMongoTestDatabase,
  getMongoIntegrationUri,
} = require("../../test-utils/mongoIntegrationSafety");

const WARMUP = 100;
const MEASURED = 1000;
const RUNS = 3;
const SEED = 20261113;
const POLL_MS = 100;
const TIMEOUT_MS = 120000;
const FIXED_DECISION_GROUP = "crypto-analytics-group";

function validateEnvironment(env) {
  if (env.RUN_DISPOSABLE_ANALYTICS_BENCHMARK !== "true") {
    throw new Error("RUN_DISPOSABLE_ANALYTICS_BENCHMARK=true is required.");
  }
  if (!env.KAFKA_INTEGRATION_BROKER || !env.MONGO_INTEGRATION_URI) {
    throw new Error("KAFKA_INTEGRATION_BROKER and MONGO_INTEGRATION_URI are required.");
  }
  const broker = getKafkaIntegrationBroker(env);
  const mongoUri = getMongoIntegrationUri(env);
  if (!broker || !mongoUri) throw new Error("Both integration endpoints are required.");
  const parsed = new URL(mongoUri);
  if (parsed.username || parsed.password) {
    throw new Error("Benchmark MongoDB URIs must not contain credentials.");
  }
  return { broker, mongoUri };
}

function payload(index) {
  return JSON.stringify({
    symbol: "BTC-USD",
    price: 100 + ((SEED + index * 17) % 70) / 100,
    timestamp: new Date(Date.UTC(2025, 0, 1) + index * 1000).toISOString(),
  });
}

function percentile(samples, fraction) {
  if (!samples.length || fraction <= 0 || fraction > 1 ||
      samples.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Invalid latency samples or percentile.");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function createMeasurements(topic, warmup = WARMUP, measured = MEASURED, now = () => performance.now()) {
  const seen = new Set();
  const successful = new Set();
  const samples = [];
  let firstStart;
  let lastEnd;
  let measuredAllowed = false;
  return {
    startMeasured() {
      if (measuredAllowed || seen.size !== warmup || successful.size !== warmup) {
        throw new Error("Cannot start measured callbacks before successful warm-up.");
      }
      measuredAllowed = true;
    },
    async process(record, callback) {
      if (record.topic !== topic || record.partition !== 0 ||
          typeof record.message.offset !== "string" ||
          !/^(0|[1-9]\d*)$/.test(record.message.offset)) {
        throw new Error("Unexpected Kafka record identity.");
      }
      const offset = BigInt(record.message.offset);
      if (offset >= BigInt(warmup) && !measuredAllowed) {
        throw new Error("Measured record arrived before the verified backlog was released.");
      }
      if (offset >= BigInt(warmup + measured) || seen.has(record.message.offset)) {
        throw new Error("Unexpected or duplicate Kafka record.");
      }
      seen.add(record.message.offset);
      const isMeasured = offset >= BigInt(warmup);
      const started = now();
      if (isMeasured && firstStart === undefined) firstStart = started;
      await callback(record);
      const finished = now();
      successful.add(record.message.offset);
      if (isMeasured) {
        lastEnd = finished;
        samples.push({ offset: record.message.offset, startedMs: started, finishedMs: finished, latencyMs: finished - started });
      }
    },
    get successfulCount() { return successful.size; },
    verify() {
      if (seen.size !== warmup + measured || successful.size !== warmup + measured ||
          samples.length !== measured) {
        throw new Error("Unexpected callback counts or unsuccessful processing.");
      }
      for (let index = 0; index < warmup + measured; index++) {
        if (!successful.has(String(index))) throw new Error("Missing Kafka record identity.");
      }
      const durationMs = lastEnd - firstStart;
      if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error("Invalid processing duration.");
      const latencies = samples.map((sample) => sample.latencyMs);
      return {
        warmupCallbacks: warmup,
        measuredCallbacks: samples.length,
        firstCallbackStartedMs: firstStart,
        lastCallbackFinishedMs: lastEnd,
        durationMs,
        observedBackloggedCallbacksPerSecond: measured * 1000 / durationMs,
        p50Ms: percentile(latencies, 0.5),
        p95Ms: percentile(latencies, 0.95),
        samples,
      };
    },
  };
}

function durationBetween(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("Invalid measurement boundaries.");
  }
  return end - start;
}

function verifyIdentities(documents, expectedIds, label) {
  const ids = documents.map((document) => document._id);
  const expected = new Set(expectedIds);
  if (ids.length !== expectedIds.length || new Set(ids).size !== ids.length ||
      expected.size !== expectedIds.length || ids.some((id) => !expected.has(id))) {
    throw new Error(`${label} identities do not match acknowledged Kafka records.`);
  }
}

function summarizeSendAndCommit(sendStart, finalAcknowledgement, restartRequestedAt, lastCallbackFinishedAt, commitObservedAt, count) {
  const durationMs = durationBetween(sendStart, finalAcknowledgement);
  if (durationMs <= 0 || !Number.isInteger(count) || count <= 0) {
    throw new Error("Invalid producer duration or count.");
  }
  durationBetween(finalAcknowledgement, restartRequestedAt);
  durationBetween(lastCallbackFinishedAt, commitObservedAt);
  return {
    sendDurationMs: durationMs,
    acknowledgedPerSecond: count * 1000 / durationMs,
    restartToLastCallbackMs: durationBetween(restartRequestedAt, lastCallbackFinishedAt),
    restartToCommitObservedMs: durationBetween(restartRequestedAt, commitObservedAt),
  };
}

function trackConsumerReadiness(consumer, topic) {
  let joined = false;
  let fetched = false;
  consumer.on(consumer.events.GROUP_JOIN, ({ payload: event }) => {
    joined = event.memberAssignment[topic]?.includes(0) === true;
    fetched = false;
  });
  consumer.on(consumer.events.REBALANCING, () => { joined = false; fetched = false; });
  consumer.on(consumer.events.FETCH, () => { if (joined) fetched = true; });
  return () => joined && fetched;
}

function verifyBacklog(offsets, committed, group, topic, groupId, callbacks, warmup, measured) {
  if (offsets.length !== 1 || offsets[0].partition !== 0 ||
      offsets[0].low !== "0" || offsets[0].high !== String(warmup + measured) ||
      committed !== String(warmup) || callbacks !== warmup ||
      group.groups?.length !== 1 || group.groups[0].groupId !== groupId ||
      group.groups[0].state !== "Empty" || !Array.isArray(group.groups[0].members) ||
      group.groups[0].members.length !== 0) {
    throw new Error(`Unable to verify stopped consumer and measured backlog for ${topic}.`);
  }
  return { committedOffset: committed, endOffset: offsets[0].high, queuedRecords: measured };
}

async function captureAnalyticsCallback(db, topic, broker) {
  const filename = path.resolve(__dirname, "../src/kafkaConsumer.js");
  const nativeRequire = Module.createRequire(filename);
  const config = {
    ...nativeRequire("./config"),
    kafkaBroker: broker,
    kafkaTopic: topic,
    dbName: db.databaseName,
    processingTimings: false,
    verboseEventLogging: false,
    decisionCleanupEnabled: false,
    maxEventsPerSymbol: 10000,
  };
  let callback;
  let consumerCreated = false;
  let subscribed = false;
  const fakeConsumer = {
    async connect() {},
    async subscribe(options) {
      if (options.topic !== topic || options.fromBeginning !== true) throw new Error("Unsafe analytics subscription.");
      subscribed = true;
    },
    async run(options) {
      if (!subscribed || callback || typeof options.eachMessage !== "function" ||
          Object.keys(options).some((key) => key !== "eachMessage")) {
        throw new Error("Cannot safely capture analytics callback.");
      }
      callback = options.eachMessage;
    },
  };
  class FakeKafka {
    consumer(options) {
      if (consumerCreated || options.groupId !== FIXED_DECISION_GROUP ||
          Object.keys(options).length !== 1) {
        throw new Error("Unexpected analytics consumer configuration.");
      }
      consumerCreated = true;
      return fakeConsumer;
    }
    admin() { throw new Error("Production reconciliation is not part of this benchmark."); }
  }
  const load = (request) => {
    if (request === "kafkajs") return { Kafka: FakeKafka };
    if (request === "./mongoClient") return { getDB: () => db };
    if (request === "./config") return config;
    return nativeRequire(request);
  };
  const localModule = { exports: {} };
  const script = new vm.Script(Module.wrap(fs.readFileSync(filename, "utf8")), { filename });
  script.runInThisContext()(localModule.exports, load, localModule, filename, path.dirname(filename));
  if (typeof localModule.exports.startConsumer !== "function" || !consumerCreated) {
    throw new Error("Cannot safely capture the production analytics consumer.");
  }
  await localModule.exports.startConsumer();
  if (!callback || !subscribed) throw new Error("Analytics callback was not captured.");
  return { callback, config };
}

async function waitFor(label, check, getFailure) {
  const deadline = performance.now() + TIMEOUT_MS;
  while (performance.now() < deadline) {
    const failure = getFailure();
    if (failure) throw failure;
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function isCoordinatorTransient(error) {
  const cause = error && error.name === "KafkaJSNumberOfRetriesExceeded" ? error.cause : error;
  return cause && ([14, 15, 16].includes(cause.code) ||
    ["GROUP_LOAD_IN_PROGRESS", "GROUP_COORDINATOR_NOT_AVAILABLE", "NOT_COORDINATOR_FOR_GROUP"].includes(cause.type));
}

async function runOnce(settings, run) {
  const { Kafka, logLevel } = require("kafkajs");
  const { MongoClient } = require("mongodb");
  const resources = createKafkaTestResources();
  const topic = resources.createTopicName("analytics-bench");
  const groupId = resources.createGroupName("analytics-bench");
  const kafka = new Kafka({ clientId: topic, ...createKafkaConnectionOptions(settings.broker), logLevel: logLevel.NOTHING });
  const mongo = new MongoClient(settings.mongoUri);
  const admin = kafka.admin({ allowAutoTopicCreation: false });
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const consumer = kafka.consumer({ groupId, allowAutoTopicCreation: false });
  let db, mongoAttempted = false, adminAttempted = false, producerAttempted = false;
  let consumerAttempted = false, adminConnected = false, topicCreated = false, groupAttempted = false;
  let failure, result, fatal;
  const cleanupErrors = [];
  const clean = async (label, action) => {
    try { await action(); } catch (error) { cleanupErrors.push(`${label}: ${error.message}`); }
  };
  try {
    mongoAttempted = true;
    await mongo.connect();
    db = createMongoTestDatabase(mongo, "analytics_benchmark");
    const mongoVersion = (await db.admin().command({ buildInfo: 1 })).version;
    adminAttempted = true;
    await admin.connect();
    adminConnected = true;
    topicCreated = await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1, replicationFactor: 1 }] });
    if (!topicCreated) throw new Error("Generated Kafka topic was not created.");
    const initialOffsets = await admin.fetchTopicOffsets(topic);
    if (initialOffsets.length !== 1 || initialOffsets[0].partition !== 0 ||
        initialOffsets[0].low !== "0" || initialOffsets[0].high !== "0") {
      throw new Error("Generated topic is not an empty one-partition topic.");
    }
    const { callback, config } = await captureAnalyticsCallback(db, topic, settings.broker);
    const measurements = createMeasurements(topic);
    const isReady = trackConsumerReadiness(consumer, topic);
    consumer.on(consumer.events.CRASH, ({ payload: event }) => { fatal = event.error; });
    consumerAttempted = true;
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    groupAttempted = true;
    const runOptions = {
      eachMessage: async (record) => {
        try { await measurements.process(record, callback); }
        catch (error) { fatal = error; throw error; }
      },
    };
    await consumer.run(runOptions);
    await waitFor("consumer assignment and fetch", isReady, () => fatal);
    producerAttempted = true;
    await producer.connect();
    const expectedIds = [];
    let warmupAcknowledged = 0;
    let measuredAcknowledged = 0;
    let sendStart;
    let finalAcknowledgement;
    async function send(index) {
      if (fatal) throw fatal;
      const metadata = await producer.send({
        topic, messages: [{ partition: 0, value: payload(index) }],
      });
      const entry = metadata.find((item) => item.topicName === topic && item.partition === 0);
      const offset = entry && (entry.baseOffset !== undefined ? entry.baseOffset : entry.offset);
      if (metadata.length !== 1 || offset !== String(index)) {
        throw new Error("Unexpected producer acknowledgement or Kafka offset.");
      }
      expectedIds.push(JSON.stringify([topic, 0, offset]));
    }
    for (let index = 0; index < WARMUP; index++) {
      await send(index);
      warmupAcknowledged++;
    }
    async function committedAt(target) {
      let response;
      try {
        response = await admin.fetchOffsets({ groupId, topics: [topic], resolveOffsets: false });
      } catch (error) {
        if (isCoordinatorTransient(error)) return false;
        throw error;
      }
      const partitions = response[0]?.partitions;
      if (response.length !== 1 || response[0].topic !== topic || partitions?.length !== 1 ||
          partitions[0].partition !== 0) throw new Error("Unexpected committed-offset response.");
      const offset = partitions[0].offset;
      if (offset === "-1") return false;
      if (!/^(0|[1-9]\d*)$/.test(offset)) throw new Error("Invalid committed offset.");
      if (BigInt(offset) > BigInt(target)) throw new Error("Committed offset exceeds expected boundary.");
      return offset === String(target) ? offset : false;
    }
    await waitFor("warm-up callbacks and commits", async () =>
      measurements.successfulCount === WARMUP && await committedAt(WARMUP), () => fatal);
    await consumer.stop();
    if (fatal) throw fatal;
    await waitFor("consumer group to become empty", async () => {
      const { groups } = await admin.describeGroups([groupId]);
      if (groups.length !== 1 || groups[0].groupId !== groupId || !Array.isArray(groups[0].members)) {
        throw new Error("Unexpected consumer group description.");
      }
      return groups[0].state === "Empty" && groups[0].members.length === 0;
    }, () => fatal);
    sendStart = performance.now();
    for (let index = WARMUP; index < WARMUP + MEASURED; index++) {
      await send(index);
      measuredAcknowledged++;
    }
    finalAcknowledgement = performance.now();
    const backlog = verifyBacklog(
      await admin.fetchTopicOffsets(topic),
      await committedAt(WARMUP),
      await admin.describeGroups([groupId]),
      topic, groupId, measurements.successfulCount, WARMUP, MEASURED,
    );
    if (fatal) throw fatal;
    measurements.startMeasured();
    const restartRequestedAt = performance.now();
    await consumer.run(runOptions);
    const finalOffset = await waitFor("final committed offset", () => committedAt(WARMUP + MEASURED), () => fatal);
    const commitObservedAt = performance.now();
    await waitFor("all callbacks", () => measurements.successfulCount === WARMUP + MEASURED, () => fatal);
    await consumer.stop();
    if (fatal) throw fatal;
    const processing = measurements.verify();
    if (warmupAcknowledged !== WARMUP || measuredAcknowledged !== MEASURED ||
        new Set(expectedIds).size !== WARMUP + MEASURED) {
      throw new Error("Unexpected acknowledgement count or duplicate identity.");
    }
    const raw = await db.collection("price_events").find({}, { projection: { _id: 1 } }).toArray();
    const decisions = await db.collection("alert_decisions").find({}, { projection: { _id: 1, groupId: 1 } }).toArray();
    verifyIdentities(raw, expectedIds, "Raw event");
    verifyIdentities(decisions, expectedIds, "Decision");
    const finalOffsets = await admin.fetchTopicOffsets(topic);
    if (finalOffsets.length !== 1 || finalOffsets[0].partition !== 0 ||
        finalOffsets[0].low !== "0" || finalOffsets[0].high !== String(WARMUP + MEASURED)) {
      throw new Error("Unexpected final topic offsets.");
    }
    if (decisions.some((entry) => entry.groupId !== FIXED_DECISION_GROUP)) {
      throw new Error("Unexpected decision group metadata.");
    }
    const timings = summarizeSendAndCommit(
      sendStart, finalAcknowledgement, restartRequestedAt,
      processing.lastCallbackFinishedMs, commitObservedAt, measuredAcknowledged,
    );
    const sizes = Array.from({ length: WARMUP + MEASURED }, (_, index) => Buffer.byteLength(payload(index)));
    result = {
      run, mongoVersion, topic, groupId, database: db.databaseName,
      settings: {
        partitions: 1, consumerConcurrency: 1, warmup: WARMUP, measured: MEASURED, seed: SEED,
        payloadBytes: { minimum: Math.min(...sizes), maximum: Math.max(...sizes) },
        analytics: {
          symbols: config.symbols, alertThresholdPercent: config.alertThresholdPercent,
          alertWindowMs: config.alertWindowMs, alertBaselineToleranceMs: config.alertBaselineToleranceMs,
          alertCooldownMs: config.alertCooldownMs, movingAverageWindow: config.movingAverageWindow,
          maxEventsPerSymbol: config.maxEventsPerSymbol, decisionCleanupEnabled: false,
        },
      },
      producer: {
        warmupAcknowledged, measuredAcknowledged, sendStartedMs: sendStart,
        finalAcknowledgementMs: finalAcknowledgement, durationMs: timings.sendDurationMs,
        acknowledgedPerSecond: timings.acknowledgedPerSecond,
      },
      processing,
      backlog: { ...backlog, restartRequestedMs: restartRequestedAt },
      commit: {
        finalOffset, observedAtMs: commitObservedAt, pollingIntervalMs: POLL_MS,
        restartToLastCallbackMs: timings.restartToLastCallbackMs,
        restartToCommitObservedMs: timings.restartToCommitObservedMs,
      },
      verification: { success: true, distinctIdentities: expectedIds.length, rawEvents: raw.length, decisions: decisions.length },
    };
  } catch (error) {
    failure = error;
  } finally {
    if (consumerAttempted) await clean("consumer disconnect", () => consumer.disconnect());
    if (producerAttempted) await clean("producer disconnect", () => producer.disconnect());
    if (adminConnected && groupAttempted) await clean("group deletion", () => resources.deleteGroups(admin, [groupId]));
    if (adminConnected && topicCreated) await clean("topic deletion", () => resources.deleteTopic(admin, topic));
    if (adminAttempted) await clean("admin disconnect", () => admin.disconnect());
    if (db) await clean("database drop", () => dropMongoTestDatabase(db));
    if (mongoAttempted) await clean("MongoDB disconnect", () => mongo.close());
  }
  if (cleanupErrors.length) {
    throw new Error(`Benchmark cleanup failed: ${cleanupErrors.join("; ")}`, { cause: failure });
  }
  if (failure) throw failure;
  return result;
}

async function main() {
  const settings = validateEnvironment(process.env);
  const runs = [];
  for (let run = 1; run <= RUNS; run++) runs.push(await runOnce(settings, run));
  return {
    success: true,
    scope: "Synthetic Kafka-to-analytics-callback subsystem; not production lifecycle or end-to-end.",
    limitations: [
      "Disposable ownership must be independently established; loopback and opt-in are not proof.",
      "Production Kafka wiring and reconciliation are replaced; decision metadata uses the fixed production group name.",
      "The consumer is stopped after warm-up and restarted after backlog verification, unlike continuous production.",
      "Callback throughput is an observed backlogged rate, not maximum capacity.",
      "Restart-to-commit includes rejoining, processing, commits and polling observation delay.",
      "Kafka broker version is not exposed by the KafkaJS admin API used here.",
    ],
    versions: { node: process.version, kafkaBroker: null, kafkaJS: require("kafkajs/package.json").version },
    payload: "BTC-USD; price = 100 + ((20261113 + index * 17) % 70) / 100; timestamp = 2025-01-01 UTC + index seconds.",
    runs,
  };
}

if (require.main === module) {
  console.log = (...args) => console.error(...args);
  main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    console.error("Analytics benchmark failed:", error);
    process.stdout.write(`${JSON.stringify({ success: false, error: error.message, cause: error.cause?.message })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  captureAnalyticsCallback, createMeasurements, payload, percentile,
  summarizeSendAndCommit, trackConsumerReadiness, validateEnvironment, verifyBacklog, verifyIdentities,
};
