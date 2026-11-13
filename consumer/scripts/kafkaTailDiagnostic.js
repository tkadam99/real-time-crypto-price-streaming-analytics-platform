const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

const APPLICATION_GROUP = "crypto-analytics-group";
const SAMPLE_SIZE = 5;
const MAX_PARTITIONS = 32;
const SAMPLE_TIMEOUT_MS = 15000;
const OBSERVE_MS = 60000;

function offset(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= 9223372036854775807n ? parsed : null;
}

function eventTime(value, now = Date.now()) {
  if (typeof value !== "string") return { status: "missing-or-invalid" };
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return { status: "missing-or-invalid" };
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) {
    return { status: "missing-or-invalid" };
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return { status: "missing-or-invalid" };
  return { status: time > now ? "future" : "valid", timestamp: value, ageMs: now - time };
}

function kafkaTime(value, now = Date.now()) {
  const ms = offset(value);
  if (ms === null || ms > 8640000000000000n) return { status: "missing-or-invalid" };
  const time = Number(ms);
  return { status: time > now ? "future" : "valid", timestamp: new Date(time).toISOString(), ageMs: now - time };
}

function describeMessage(message, now = Date.now()) {
  let event;
  try {
    event = JSON.parse(message.value?.toString("utf8"));
  } catch {
    return { offset: message.offset, payload: "malformed", marketTime: { status: "missing-or-invalid" }, kafkaTime: kafkaTime(message.timestamp, now) };
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { offset: message.offset, payload: "malformed", marketTime: { status: "missing-or-invalid" }, kafkaTime: kafkaTime(message.timestamp, now) };
  }
  return {
    offset: message.offset,
    payload: "object",
    marketTime: eventTime(event.timestamp, now),
    kafkaTime: kafkaTime(message.timestamp, now),
  };
}

function snapshots(ends, groups, topic) {
  if (!Array.isArray(ends) || ends.length > MAX_PARTITIONS) throw new Error("Invalid or excessive partition count");
  const partitions = groups.find((entry) => entry.topic === topic)?.partitions || [];
  const committed = new Map(partitions.map((p) => [p.partition, p.offset]));
  return ends.map((entry) => {
    const high = offset(entry.high);
    const low = offset(entry.low);
    if (!Number.isInteger(entry.partition) || entry.partition < 0 || high === null || low === null || low > high) {
      throw new Error("Invalid topic offsets");
    }
    const rawCommit = committed.get(entry.partition);
    const commit = offset(rawCommit);
    const commitStatus = rawCommit === undefined || rawCommit === "-1"
      ? "missing" : commit === null ? "invalid" : "valid";
    return {
      partition: entry.partition, low: low.toString(), end: high.toString(),
      committed: commit === null ? null : commit.toString(),
      commitStatus,
      lag: commit === null ? null : (high - commit).toString(),
    };
  }).sort((a, b) => a.partition - b.partition);
}

function rate(delta, elapsedMs) {
  const scaled = (delta * 100000n) / BigInt(Math.max(1, Math.round(elapsedMs)));
  const sign = scaled < 0n ? "-" : "";
  const absolute = scaled < 0n ? -scaled : scaled;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function progress(before, after, elapsedMs) {
  const previous = new Map(before.map((item) => [item.partition, item]));
  const next = new Set(after.map((item) => item.partition));
  const results = after.map((current) => {
    const prior = previous.get(current.partition);
    if (!prior) return { partition: current.partition, status: "new-partition" };
    const endDelta = BigInt(current.end) - BigInt(prior.end);
    const commitDelta = prior.committed === null || current.committed === null
      ? null : BigInt(current.committed) - BigInt(prior.committed);
    return {
      partition: current.partition,
      endAdvancement: endDelta.toString(),
      endOffsetsPerSecond: rate(endDelta, elapsedMs),
      committedAdvancement: commitDelta === null ? null : commitDelta.toString(),
      committedOffsetsPerSecond: commitDelta === null ? null : rate(commitDelta, elapsedMs),
      lagChange: commitDelta === null ? null : (endDelta - commitDelta).toString(),
    };
  });
  return results.concat(before.filter((item) => !next.has(item.partition))
    .map((item) => ({ partition: item.partition, status: "missing-partition" })));
}

function sampleRanges(snapshot) {
  return snapshot.map((item) => {
    const low = BigInt(item.low), end = BigInt(item.end);
    const start = end - low > BigInt(SAMPLE_SIZE) ? end - BigInt(SAMPLE_SIZE) : low;
    return { partition: item.partition, start, end, samples: [], done: start === end };
  });
}

async function sampleTail(consumer, topic, snapshot, signal, timeoutMs = SAMPLE_TIMEOUT_MS) {
  const ranges = sampleRanges(snapshot);
  if (ranges.every((range) => range.done)) return { ranges, timedOut: false };
  let ready = false;
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  let callbackError;
  const removeCrashListener = consumer.on(consumer.events.CRASH, () => {
    callbackError = new Error("Diagnostic consumer crashed");
    finish("error");
  });
  const onAbort = () => finish("aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  let timer;
  try {
    if (signal.aborted) return { ranges, aborted: true };
    await consumer.subscribe({ topic, fromBeginning: false });
    if (signal.aborted) return { ranges, aborted: true };
    await consumer.run({
      autoCommit: false,
      eachBatchAutoResolve: false,
      eachBatch: async ({ batch, resolveOffset, isStale }) => {
        try {
          if (!ready || isStale()) return;
          const range = ranges.find((item) => item.partition === batch.partition);
          if (!range || range.done) return;
          for (const message of batch.messages) {
            if (isStale() || signal.aborted) break;
            const current = offset(message.offset);
            if (current === null) throw new Error("Invalid message offset");
            if (current >= range.end) {
              range.done = true;
              break;
            }
            if (current >= range.start && !range.samples.some((item) => item.offset === message.offset)) {
              range.samples.push(describeMessage(message));
            }
            resolveOffset(message.offset);
            if (current + 1n >= range.end || range.samples.length >= SAMPLE_SIZE) {
              range.done = true;
              break;
            }
          }
          if (range.done) consumer.pause([{ topic, partitions: [range.partition] }]);
          if (ranges.every((item) => item.done)) finish("done");
        } catch {
          callbackError = new Error("Unable to process diagnostic sample");
          finish("error");
        }
      },
    });
    if (callbackError) throw callbackError;
    if (signal.aborted) return { ranges, aborted: true };
    for (const range of ranges) {
      if (!range.done) consumer.seek({ topic, partition: range.partition, offset: range.start.toString() });
    }
    ready = true;
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    const result = await completed;
    if (result === "error") throw callbackError;
    return { ranges, timedOut: result === "timeout", aborted: result === "aborted" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    removeCrashListener();
  }
}

async function readSnapshot(admin, topic) {
  const ends = await admin.fetchTopicOffsets(topic);
  const groups = await admin.fetchOffsets({ groupId: APPLICATION_GROUP, topics: [topic], resolveOffsets: false });
  return snapshots(ends, groups, topic);
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--observe") || args.length > 1) {
    throw new Error("Usage: npm run diagnose:kafka -- [--observe]");
  }
  require("dotenv").config({ quiet: true });
  const { Kafka, logLevel } = require("kafkajs");
  const topic = process.env.KAFKA_TOPIC || "crypto-prices";
  const broker = process.env.KAFKA_BROKER || "localhost:9092";
  const id = randomUUID();
  const kafka = new Kafka({
    clientId: `tail-diagnostic-${id}`, brokers: [broker], logLevel: logLevel.NOTHING,
    requestTimeout: 10000, retry: { retries: 0 },
  });
  const admin = kafka.admin({ allowAutoTopicCreation: false });
  const consumer = kafka.consumer({
    groupId: `tail-diagnostic-${id}`, allowAutoTopicCreation: false,
    retry: { retries: 0, restartOnFailure: async () => false },
  });
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let adminAttempted = false, consumerAttempted = false;
  let failed = false;
  let stage = "connecting admin";
  try {
    adminAttempted = true;
    await admin.connect();
    if (abort.signal.aborted) return;
    stage = "reading baseline offsets";
    const baselineStart = performance.now();
    const before = await readSnapshot(admin, topic);
    const baselineEnd = performance.now();
    console.log(JSON.stringify({ kind: "baseline", observedAt: new Date().toISOString(), partitions: before }));
    if (abort.signal.aborted) return;
    stage = "connecting diagnostic consumer";
    consumerAttempted = true;
    await consumer.connect();
    stage = "sampling tail";
    const sampled = await sampleTail(consumer, topic, before, abort.signal);
    console.log(JSON.stringify({
      kind: "tail-sample", timedOut: !!sampled.timedOut, aborted: !!sampled.aborted,
      partitions: sampled.ranges.map((range) => ({
        partition: range.partition, start: range.start.toString(), endExclusive: range.end.toString(),
        complete: range.done, messages: range.samples,
      })),
    }));
    stage = "disconnecting diagnostic consumer";
    await consumer.disconnect();
    consumerAttempted = false;
    if (args.includes("--observe") && !abort.signal.aborted) {
      await wait(OBSERVE_MS - (performance.now() - baselineEnd), abort.signal);
      if (abort.signal.aborted) return;
      stage = "reading observation offsets";
      const afterStart = performance.now();
      const after = await readSnapshot(admin, topic);
      const afterEnd = performance.now();
      const elapsedMs = Math.round((afterStart + afterEnd - baselineStart - baselineEnd) / 2);
      console.log(JSON.stringify({
        kind: "observation", observedAt: new Date().toISOString(), elapsedMs,
        partitions: after, progress: progress(before, after, elapsedMs),
      }));
    }
  } catch (error) {
    failed = true;
    console.error(`Kafka diagnostic failed while ${stage}; check connectivity, permissions, and configuration.`);
  } finally {
    for (const [label, resource, connected] of [
      ["consumer", consumer, consumerAttempted], ["admin", admin, adminAttempted],
    ]) {
      if (connected) {
        try { await resource.disconnect(); } catch {
          failed = true;
          console.error(`Failed to disconnect diagnostic ${label}.`);
        }
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (failed || abort.signal.aborted) process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Kafka diagnostic failed; check arguments and configuration.");
    process.exitCode = 1;
  });
}

module.exports = { eventTime, kafkaTime, describeMessage, offset, snapshots, progress, sampleRanges, sampleTail };
