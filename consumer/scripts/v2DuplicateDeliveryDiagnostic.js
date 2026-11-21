const { execFile } = require("node:child_process");
const path = require("node:path");
const {
  parseEnvelope,
  serializeSourceIdentity,
} = require("../v2/eventContract");

const ROOT = path.resolve(__dirname, "../..");
const TOPIC = "crypto-prices-v2";
const BROKER = "v2-kafka:29092";
const PARTITIONS = Object.freeze([0, 1, 2, 3, 4, 5]);
const SYMBOLS = Object.freeze(["BTC-USD", "ETH-USD", "SOL-USD"]);
const OFFSET_CLI = "/opt/kafka/bin/kafka-get-offsets.sh";
const CONSUMER_CLI = "/opt/kafka/bin/kafka-console-consumer.sh";
const DEFAULT_MAX_RECORDS = 20000;
const MAX_RECORDS_LIMIT = 1000000;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 60000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_OFFSET = 9223372036854775807n;

function composePrefix() {
  return [
    "compose",
    "-p",
    "crypto-v2",
    "-f",
    path.join(ROOT, "docker-compose.v2.yml"),
    "exec",
    "-T",
    "v2-kafka",
  ];
}

function createDockerCliExecutor(execFileImpl = execFile) {
  if (typeof execFileImpl !== "function") {
    throw new Error("Invalid diagnostic subprocess executor.");
  }

  return (args, { timeoutMs }) => new Promise((resolve, reject) => {
    execFileImpl(
      "docker",
      [...composePrefix(), ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        shell: false,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error("Kafka diagnostic subprocess failed."));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
  });
}

function validateOptions({ maxRecords, timeoutMs }) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 ||
      maxRecords > MAX_RECORDS_LIMIT) {
    throw new Error(`maxRecords must be between 1 and ${MAX_RECORDS_LIMIT}.`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}.`);
  }
}

function parseOffset(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= MAX_OFFSET ? parsed : null;
}

function parseOffsetSnapshot(stdout) {
  if (typeof stdout !== "string") {
    throw new Error("Invalid Kafka offset snapshot.");
  }
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const offsets = new Map();
  for (const line of lines) {
    const match = new RegExp(`^${TOPIC}:([0-5]):(0|[1-9][0-9]*)$`).exec(line);
    if (!match) throw new Error("Invalid Kafka offset snapshot.");
    const partition = Number(match[1]);
    const offset = parseOffset(match[2]);
    if (offset === null || offsets.has(partition)) {
      throw new Error("Invalid Kafka offset snapshot.");
    }
    offsets.set(partition, offset);
  }
  if (offsets.size !== PARTITIONS.length ||
      PARTITIONS.some((partition) => !offsets.has(partition))) {
    throw new Error("Incomplete Kafka offset snapshot.");
  }
  return offsets;
}

function parseConsumerOutput(stdout, expectedPartition) {
  const records = [];
  const malformedLines = [];
  if (typeof stdout !== "string") {
    return { records, malformedLines: ["invalid-output"] };
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^Partition:([0-9]+)\tOffset:(0|[1-9][0-9]*)\t(.*)$/.exec(line);
    if (!match) {
      malformedLines.push("invalid-record-line");
      continue;
    }
    const partition = Number(match[1]);
    const offset = parseOffset(match[2]);
    if (partition !== expectedPartition || offset === null) {
      malformedLines.push("invalid-record-identity");
      continue;
    }
    records.push({ partition, offset, value: match[3] });
  }
  return { records, malformedLines };
}

function offsetArguments(time) {
  return [
    OFFSET_CLI,
    "--bootstrap-server",
    BROKER,
    "--topic",
    TOPIC,
    "--time",
    time,
  ];
}

function consumerArguments(partition, startOffset, maxMessages, timeoutMs) {
  return [
    CONSUMER_CLI,
    "--bootstrap-server",
    BROKER,
    "--topic",
    TOPIC,
    "--partition",
    String(partition),
    "--offset",
    startOffset,
    "--max-messages",
    String(maxMessages),
    "--timeout-ms",
    String(timeoutMs),
    "--consumer-property",
    "enable.auto.commit=false",
    "--property",
    "print.partition=true",
    "--property",
    "print.offset=true",
  ];
}

async function execute(executeCommand, args, timeoutMs) {
  const result = await executeCommand(args, { timeoutMs });
  if (!result || typeof result.stdout !== "string" ||
      (result.exitCode !== undefined && result.exitCode !== 0)) {
    throw new Error("Kafka diagnostic subprocess failed.");
  }
  return result.stdout;
}

function createReport(maxRecords, timeoutMs) {
  return {
    topic: TOPIC,
    maxRecords,
    timeoutMs,
    bounds: [],
    scannedRecords: 0,
    malformedEnvelopes: 0,
    crossSymbolIdentityConflicts: 0,
    incompleteReads: [],
    offsetBoundDiscrepancies: [],
    bySymbol: Object.fromEntries(SYMBOLS.map((symbol) => [symbol, {
      totalRecords: 0,
      uniqueIdentities: 0,
      identitiesOccurringMoreThanOnce: 0,
      extraDuplicateDeliveries: 0,
    }])),
    complete: false,
  };
}

async function runDiagnostic({
  executeCommand,
  maxRecords = DEFAULT_MAX_RECORDS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  validateOptions({ maxRecords, timeoutMs });
  if (typeof executeCommand !== "function") {
    throw new Error("A diagnostic subprocess executor is required.");
  }

  const report = createReport(maxRecords, timeoutMs);
  let starts;
  let ends;
  try {
    starts = parseOffsetSnapshot(await execute(
      executeCommand,
      offsetArguments("-2"),
      timeoutMs,
    ));
    ends = parseOffsetSnapshot(await execute(
      executeCommand,
      offsetArguments("-1"),
      timeoutMs,
    ));
  } catch {
    report.incompleteReads.push({ partition: null, reason: "offset-snapshot-failed" });
    report.offsetBoundDiscrepancies.push({ partition: null, reason: "offset-snapshot-unavailable" });
    return report;
  }

  let offsetSpanTotal = 0n;
  for (const partition of PARTITIONS) {
    const start = starts.get(partition);
    const end = ends.get(partition);
    if (end < start) {
      report.offsetBoundDiscrepancies.push({ partition, reason: "end-before-start" });
      continue;
    }
    const span = end - start;
    offsetSpanTotal += span;
    report.bounds.push({
      partition,
      startOffset: start.toString(),
      endOffsetExclusive: end.toString(),
    });
  }
  if (report.offsetBoundDiscrepancies.length > 0) {
    report.incompleteReads.push({ partition: null, reason: "invalid-offset-bounds" });
    return report;
  }
  if (offsetSpanTotal > BigInt(maxRecords)) {
    report.incompleteReads.push({ partition: null, reason: "maximum-record-count-exceeded" });
    return report;
  }

  const identitiesBySymbol = new Map(SYMBOLS.map((symbol) => [symbol, new Map()]));
  const symbolsByIdentity = new Map();

  for (const partition of PARTITIONS) {
    const start = starts.get(partition);
    const end = ends.get(partition);
    const span = end - start;
    if (span === 0n) continue;

    let stdout;
    try {
      stdout = await execute(
        executeCommand,
        consumerArguments(partition, start.toString(), Number(span), timeoutMs),
        timeoutMs,
      );
    } catch {
      report.incompleteReads.push({ partition, reason: "partition-read-failed" });
      continue;
    }

    const { records, malformedLines } = parseConsumerOutput(stdout, partition);
    if (malformedLines.length > 0) {
      report.offsetBoundDiscrepancies.push({
        partition,
        reason: "invalid-consumer-output",
        count: malformedLines.length,
      });
    }

    let previousOffset = null;
    let expectedOffset = start;
    let offsetGapCount = 0n;
    let inRangeRecordCount = 0;
    for (const record of records) {
      if (record.offset < start || record.offset >= end ||
          (previousOffset !== null && record.offset <= previousOffset)) {
        report.offsetBoundDiscrepancies.push({
          partition,
          reason: "record-outside-or-out-of-order",
        });
        continue;
      }
      if (record.offset > expectedOffset) {
        offsetGapCount += record.offset - expectedOffset;
      }
      previousOffset = record.offset;
      expectedOffset = record.offset + 1n;
      inRangeRecordCount += 1;
      report.scannedRecords += 1;

      let envelope;
      try {
        envelope = parseEnvelope(record.value);
      } catch {
        report.malformedEnvelopes += 1;
        continue;
      }

      const identity = serializeSourceIdentity(envelope.source);
      const symbolIdentities = identitiesBySymbol.get(envelope.symbol);
      symbolIdentities.set(identity, (symbolIdentities.get(identity) || 0) + 1);
      if (!symbolsByIdentity.has(identity)) symbolsByIdentity.set(identity, new Set());
      symbolsByIdentity.get(identity).add(envelope.symbol);
      report.bySymbol[envelope.symbol].totalRecords += 1;
    }
    if (expectedOffset < end) offsetGapCount += end - expectedOffset;
    if (offsetGapCount > 0n) {
      report.offsetBoundDiscrepancies.push({
        partition,
        reason: "offset-gap",
        count: offsetGapCount.toString(),
      });
    }
    if (BigInt(inRangeRecordCount) !== span) {
      report.incompleteReads.push({ partition, reason: "record-count-differs-from-offset-span" });
    }
  }

  for (const [symbol, identityCounts] of identitiesBySymbol) {
    const summary = report.bySymbol[symbol];
    summary.uniqueIdentities = identityCounts.size;
    for (const count of identityCounts.values()) {
      if (count > 1) {
        summary.identitiesOccurringMoreThanOnce += 1;
        summary.extraDuplicateDeliveries += count - 1;
      }
    }
  }
  report.crossSymbolIdentityConflicts = [...symbolsByIdentity.values()]
    .filter((symbols) => symbols.size > 1).length;
  report.complete = report.incompleteReads.length === 0 &&
    report.offsetBoundDiscrepancies.length === 0;
  return report;
}

function parseArguments(args) {
  const options = {
    execute: false,
    maxRecords: DEFAULT_MAX_RECORDS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--execute") {
      if (options.execute) throw new Error("Duplicate --execute option.");
      options.execute = true;
    } else if (arg === "--max-records" || arg === "--timeout-ms") {
      const value = args[index + 1];
      if (value === undefined || !/^[0-9]+$/.test(value)) {
        throw new Error(`Invalid value for ${arg}.`);
      }
      index += 1;
      if (arg === "--max-records") options.maxRecords = Number(value);
      else options.timeoutMs = Number(value);
    } else {
      throw new Error("Unsupported diagnostic option.");
    }
  }
  validateOptions(options);
  return options;
}

async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(args);
  if (!options.execute) {
    throw new Error("Explicit --execute opt-in is required.");
  }
  const executeCommand = dependencies.executeCommand ||
    createDockerCliExecutor(dependencies.execFileImpl);
  const report = await runDiagnostic({
    executeCommand,
    maxRecords: options.maxRecords,
    timeoutMs: options.timeoutMs,
  });
  const output = dependencies.stdout || console;
  output.log(JSON.stringify(report));
  if (!report.complete) {
    if (dependencies.processObject) dependencies.processObject.exitCode = 1;
    else process.exitCode = 1;
  }
  return { executed: true, report };
}

if (require.main === module) {
  main().catch(() => {
    console.error("V2 duplicate-delivery diagnostic failed; no payload or subprocess output was logged.");
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  DEFAULT_TIMEOUT_MS,
  PARTITIONS,
  TOPIC,
  consumerArguments,
  createDockerCliExecutor,
  main,
  parseArguments,
  parseConsumerOutput,
  parseOffsetSnapshot,
  runDiagnostic,
};
