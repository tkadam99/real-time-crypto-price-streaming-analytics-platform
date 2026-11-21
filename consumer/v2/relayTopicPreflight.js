const V1_TOPIC = "crypto-prices";
const TOPIC_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TOPIC_PREFLIGHT_COMMAND = "docker";
const TOPIC_PREFLIGHT_ARGS = Object.freeze([
  "exec",
  "kafka",
  "kafka-topics",
  "--bootstrap-server",
  "localhost:9092",
  "--describe",
  "--topic",
  V1_TOPIC,
]);

function getFieldValues(line, field) {
  const pattern = new RegExp(`(?:^|\\s)${field}\\s*:\\s*([^\\s]+)`, "g");
  return [...line.matchAll(pattern)].map((match) => match[1]);
}

function parseTopicId(output) {
  if (typeof output !== "string" || output.trim() === "") {
    throw new Error("V1 Kafka topic-ID preflight returned unexpected output.");
  }

  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const summaryLines = [];
  const partitionLines = [];

  for (const line of lines) {
    if (!/^Topic:\s*crypto-prices(?:\s|$)/.test(line)) {
      throw new Error("V1 Kafka topic-ID preflight returned unexpected output.");
    }

    if (getFieldValues(line, "PartitionCount").length > 0 ||
        getFieldValues(line, "ReplicationFactor").length > 0) {
      if (getFieldValues(line, "PartitionCount").length !== 1 ||
          getFieldValues(line, "ReplicationFactor").length !== 1) {
        throw new Error("V1 Kafka topic-ID preflight returned unexpected output.");
      }
      summaryLines.push(line);
    } else if (getFieldValues(line, "Partition").length === 1 &&
        getFieldValues(line, "Leader").length === 1) {
      partitionLines.push(line);
    } else {
      throw new Error("V1 Kafka topic-ID preflight returned unexpected output.");
    }
  }

  if (summaryLines.length !== 1 || partitionLines.length === 0) {
    throw new Error("V1 Kafka topic-ID preflight returned unexpected output.");
  }

  const topicIdFields = lines.flatMap((line) => getFieldValues(line, "TopicId"));
  const summaryTopicIds = getFieldValues(summaryLines[0], "TopicId");
  if (topicIdFields.length !== 1 || summaryTopicIds.length !== 1 ||
      !TOPIC_ID_PATTERN.test(summaryTopicIds[0])) {
    throw new Error("V1 Kafka topic ID is missing, malformed, or ambiguous.");
  }

  return summaryTopicIds[0];
}

async function verifyV1TopicId(relayConfig, executeCommand) {
  const expectedTopicId = relayConfig && relayConfig.sourceIdentity &&
    relayConfig.sourceIdentity.topicGenerationId;
  if (relayConfig?.v1Topic !== V1_TOPIC ||
      typeof expectedTopicId !== "string" ||
      !TOPIC_ID_PATTERN.test(expectedTopicId)) {
    throw new Error("Invalid relay configuration for V1 topic-ID preflight.");
  }
  if (typeof executeCommand !== "function") {
    throw new Error("Invalid command executor for V1 topic-ID preflight.");
  }

  let result;
  try {
    result = await executeCommand(
      TOPIC_PREFLIGHT_COMMAND,
      [...TOPIC_PREFLIGHT_ARGS],
      { shell: false },
    );
  } catch {
    throw new Error("V1 Kafka topic-ID preflight command failed.");
  }

  if (!result || typeof result.stdout !== "string" ||
      (result.exitCode !== undefined && result.exitCode !== 0) ||
      (result.stderr !== undefined &&
        (typeof result.stderr !== "string" || result.stderr.trim() !== ""))) {
    throw new Error("V1 Kafka topic-ID preflight command failed.");
  }

  const liveTopicId = parseTopicId(result.stdout);
  if (liveTopicId !== expectedTopicId) {
    throw new Error("Live V1 Kafka topic ID does not match the configured topic generation.");
  }

  return true;
}

module.exports = {
  TOPIC_PREFLIGHT_COMMAND,
  TOPIC_PREFLIGHT_ARGS,
  verifyV1TopicId,
};
