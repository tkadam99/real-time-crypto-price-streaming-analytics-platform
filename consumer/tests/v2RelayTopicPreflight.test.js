const { loadRelayConfig } = require("../v2/relayConfig");
const { verifyV1TopicId } = require("../v2/relayTopicPreflight");

const relayConfig = loadRelayConfig({
  V1_SOURCE_CLUSTER_ID: "0jtOiYT4QmShqPK0HjBpQA",
  V1_SOURCE_TOPIC_GENERATION_ID: "9ShfnW90Th-vI4A2Jl1O4Q",
  V2_DESTINATION_CLUSTER_ID: "4L6g3nShT-eMCtK--X86sw",
});
const topicId = relayConfig.sourceIdentity.topicGenerationId;
const describeOutput = `Topic: crypto-prices    TopicId: ${topicId} PartitionCount: 1 ReplicationFactor: 1 Configs: cleanup.policy=delete
  Topic: crypto-prices Partition: 0 Leader: 1 Replicas: 1 Isr: 1`;

function createExecutor(result) {
  return jest.fn().mockResolvedValue(result);
}

test("verifies the configured topic ID using only the approved Docker command", async () => {
  const executeCommand = createExecutor({ stdout: describeOutput, exitCode: 0, stderr: "" });

  await expect(verifyV1TopicId(relayConfig, executeCommand)).resolves.toBe(true);

  expect(executeCommand).toHaveBeenCalledTimes(1);
  expect(executeCommand).toHaveBeenCalledWith("docker", [
    "exec",
    "kafka",
    "kafka-topics",
    "--bootstrap-server",
    "localhost:9092",
    "--describe",
    "--topic",
    "crypto-prices",
  ], { shell: false });
});

test("rejects a mismatched topic ID", async () => {
  const executeCommand = createExecutor({
    stdout: describeOutput.replace(topicId, "9ShfnW90Th-vI4A2Jl1O4A"),
  });

  await expect(verifyV1TopicId(relayConfig, executeCommand))
    .rejects.toThrow("does not match the configured topic generation");
});

test("rejects output without a topic ID", async () => {
  const executeCommand = createExecutor({
    stdout: describeOutput.replace(`TopicId: ${topicId} `, ""),
  });

  await expect(verifyV1TopicId(relayConfig, executeCommand))
    .rejects.toThrow("missing, malformed, or ambiguous");
});

test.each([
  ["malformed ID", describeOutput.replace(topicId, "not-a-topic-id")],
  ["ambiguous IDs", describeOutput.replace(
    `TopicId: ${topicId}`,
    `TopicId: ${topicId} TopicId: ${topicId}`,
  )],
  ["unexpected output", `${describeOutput}\nTopic: another-topic TopicId: ${topicId}`],
  ["unexpected text", `warning: unexpected\n${describeOutput}`],
])("rejects %s", async (_caseName, stdout) => {
  const executeCommand = createExecutor({ stdout });

  await expect(verifyV1TopicId(relayConfig, executeCommand)).rejects.toThrow();
});

test("fails closed and sanitizes command failures without retrying", async () => {
  const executeCommand = jest.fn().mockRejectedValue(
    new Error("password=private; command output contains secret"),
  );

  let error;
  try {
    await verifyV1TopicId(relayConfig, executeCommand);
  } catch (caught) {
    error = caught;
  }

  expect(error.message).toBe("V1 Kafka topic-ID preflight command failed.");
  expect(error.message).not.toContain("private");
  expect(error.message).not.toContain("secret");
  expect(executeCommand).toHaveBeenCalledTimes(1);
});

test("rejects a nonzero command exit code", async () => {
  const executeCommand = createExecutor({
    stdout: describeOutput,
    stderr: "",
    exitCode: 1,
  });

  await expect(verifyV1TopicId(relayConfig, executeCommand))
    .rejects.toThrow("V1 Kafka topic-ID preflight command failed.");
});

test("rejects nonempty command stderr", async () => {
  const executeCommand = createExecutor({
    stdout: describeOutput,
    stderr: "warning: unexpected output",
    exitCode: 0,
  });

  await expect(verifyV1TopicId(relayConfig, executeCommand))
    .rejects.toThrow("V1 Kafka topic-ID preflight command failed.");
});
