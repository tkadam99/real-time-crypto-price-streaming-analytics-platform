const {
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  HISTORY_TOPIC,
} = require("./historyConsumerConfig");

const HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND = "docker";
const HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS = Object.freeze([
  "compose",
  "-p",
  "crypto-v2",
  "-f",
  "docker-compose.v2.yml",
  "exec",
  "-T",
  "v2-kafka",
  "/opt/kafka/bin/kafka-topics.sh",
  "--bootstrap-server",
  "v2-kafka:29092",
  "--describe",
  "--topic",
  HISTORY_TOPIC,
]);
const HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS = 15000;
const HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER = 65536;
const TOPIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PARTITION_IDS = Object.freeze([0, 1, 2, 3, 4, 5]);

const SUMMARY_LINE_PATTERN =
  /^Topic:\s+(\S+)\s+TopicId:\s+(\S+)\s+PartitionCount:\s+(\d+)\s+ReplicationFactor:\s+(\d+)(?:\s+Configs:(?:\s+[A-Za-z0-9_.-]+=[A-Za-z0-9_.=,+-]+)?)?$/;
const PARTITION_LINE_PATTERN =
  /^Topic:\s+(\S+)\s+Partition:\s+(0|[1-9]\d*)\s+Leader:\s+(0|[1-9]\d*)\s+Replicas:\s+(\S+)\s+Isr:\s+(\S+)(?:\s+OfflineReplicas:\s+(\S+))?(?:\s+(Elr:\s*([^\s]*)\s+LastKnownElr:\s*([^\s]*)))?$/;

function isApprovedHistorySmokeTopicCommand(command, args) {
  return command === HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND &&
    Array.isArray(args) &&
    args.length === HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS.length &&
    args.every((arg, index) =>
      arg === HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS[index]);
}

function countFields(line, field) {
  const pattern = new RegExp(`(?:^|\\s)${field}:\\s*\\S+`, "g");
  return [...line.matchAll(pattern)].length;
}

function invalidMetadata() {
  return new Error(
    "V2 history smoke topic-ID preflight returned invalid or ambiguous metadata.",
  );
}

function parseBrokerIdList(value, allowEmpty = false) {
  if (allowEmpty && value === "") return [];
  if (typeof value !== "string" || value === "") throw invalidMetadata();

  const ids = value.split(",").map((token) => {
    if (!/^(0|[1-9]\d*)$/.test(token)) throw invalidMetadata();
    const id = Number(token);
    if (!Number.isSafeInteger(id)) throw invalidMetadata();
    return id;
  });
  if (new Set(ids).size !== ids.length) throw invalidMetadata();
  return ids;
}

function parseHistorySmokeTopicMetadata(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    throw invalidMetadata();
  }

  const summaryLines = [];
  const partitionLines = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const summary = SUMMARY_LINE_PATTERN.exec(line);
    if (summary) {
      if (countFields(line, "Topic") !== 1 ||
          countFields(line, "TopicId") !== 1 ||
          countFields(line, "PartitionCount") !== 1 ||
          countFields(line, "ReplicationFactor") !== 1) {
        throw invalidMetadata();
      }
      summaryLines.push({
        topic: summary[1],
        topicId: summary[2],
        partitionCount: Number(summary[3]),
        replicationFactor: Number(summary[4]),
      });
      continue;
    }

    const partition = PARTITION_LINE_PATTERN.exec(line);
    if (!partition) throw invalidMetadata();
    const replicas = parseBrokerIdList(partition[4]);
    const isr = parseBrokerIdList(partition[5]);
    const offlineReplicas = partition[6] === undefined
      ? []
      : parseBrokerIdList(partition[6]);
    const hasElrFields = partition[7] !== undefined;
    const elr = hasElrFields
      ? parseBrokerIdList(partition[8], true)
      : [];
    const lastKnownElr = hasElrFields
      ? parseBrokerIdList(partition[9], true)
      : [];
    partitionLines.push({
      topic: partition[1],
      partitionId: Number(partition[2]),
      leader: Number(partition[3]),
      replicas,
      isr,
      offlineReplicas,
      elr,
      lastKnownElr,
    });
  }

  if (summaryLines.length !== 1 || partitionLines.length !== 6) {
    throw invalidMetadata();
  }

  const summary = summaryLines[0];
  if (summary.topic !== HISTORY_TOPIC ||
      !TOPIC_ID_PATTERN.test(summary.topicId) ||
      !Number.isSafeInteger(summary.partitionCount) ||
      summary.partitionCount !== PARTITION_IDS.length ||
      !Number.isSafeInteger(summary.replicationFactor) ||
      summary.replicationFactor < 1) {
    throw invalidMetadata();
  }

  const seenPartitionIds = new Set();
  for (const partition of partitionLines) {
    if (partition.topic !== HISTORY_TOPIC ||
        !Number.isSafeInteger(partition.partitionId) ||
        !PARTITION_IDS.includes(partition.partitionId) ||
        seenPartitionIds.has(partition.partitionId) ||
        !Number.isSafeInteger(partition.leader) ||
        partition.leader < 0) {
      throw invalidMetadata();
    }
    seenPartitionIds.add(partition.partitionId);
  }
  if (seenPartitionIds.size !== PARTITION_IDS.length) {
    throw invalidMetadata();
  }

  return summary;
}

function validateSmokeConfiguration(config) {
  if (!config || config.enabled !== true ||
      config.liveStartAcknowledged !== true ||
      !config.firstRunSmoke ||
      config.firstRunSmoke.enabled !== true ||
      !config.kafka ||
      config.kafka.expectedTopicId !== FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID) {
    throw new Error(
      "Invalid V2 history first-run smoke topic-ID preflight configuration.",
    );
  }
}

async function verifyHistorySmokeTopicIdentity({ config, executeCommand } = {}) {
  validateSmokeConfiguration(config);
  if (typeof executeCommand !== "function") {
    throw new Error("Invalid command executor for V2 history smoke topic-ID preflight.");
  }

  const command = HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND;
  const args = [...HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS];
  if (!isApprovedHistorySmokeTopicCommand(command, args)) {
    throw new Error("Invalid fixed command for V2 history smoke topic-ID preflight.");
  }

  let result;
  try {
    result = await executeCommand(command, args, {
      encoding: "utf8",
      maxBuffer: HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER,
      shell: false,
      timeout: HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
    });
  } catch {
    throw new Error("V2 history smoke topic-ID preflight command failed.");
  }

  if (!result || result.exitCode !== 0 ||
      typeof result.stdout !== "string" ||
      result.stdout.length > HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER ||
      typeof result.stderr !== "string" ||
      result.stderr !== "" ||
      (result.error !== undefined && result.error !== null)) {
    throw new Error("V2 history smoke topic-ID preflight command failed.");
  }

  const observed = parseHistorySmokeTopicMetadata(result.stdout);
  if (observed.topicId !== config.kafka.expectedTopicId) {
    throw new Error(
      "Live V2 history topic ID does not match the configured smoke identity.",
    );
  }

  return Object.freeze({
    topic: HISTORY_TOPIC,
    topicId: observed.topicId,
    partitionCount: PARTITION_IDS.length,
    partitionIds: PARTITION_IDS,
  });
}

module.exports = {
  HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_MAX_BUFFER,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
  isApprovedHistorySmokeTopicCommand,
  parseHistorySmokeTopicMetadata,
  verifyHistorySmokeTopicIdentity,
};
