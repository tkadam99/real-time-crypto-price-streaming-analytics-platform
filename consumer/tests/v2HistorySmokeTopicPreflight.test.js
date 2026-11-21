const {
  FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  LIVE_START_ACKNOWLEDGEMENT,
  loadHistoryConsumerConfig,
} = require("../v2/historyConsumerConfig");
const {
  HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND,
  HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
  isApprovedHistorySmokeTopicCommand,
  verifyHistorySmokeTopicIdentity,
} = require("../v2/historySmokeTopicPreflight");

const HISTORY_TOPIC = "crypto-prices-v2";
const smokeConfig = loadHistoryConsumerConfig({
  V2_HISTORY_CONSUMER_ENABLED: "true",
  V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
  V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
  V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: "10",
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "60000",
  V2_HISTORY_TOPIC_ID: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
});

function summaryLine({
  topic = HISTORY_TOPIC,
  topicId = FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  partitionCount = 6,
  replicationFactor = 1,
  configs = "",
} = {}) {
  return `Topic: ${topic} TopicId: ${topicId} PartitionCount: ${partitionCount} ReplicationFactor: ${replicationFactor} Configs:${configs ? ` ${configs}` : ""}`;
}

function partitionLine({
  topic = HISTORY_TOPIC,
  partition = 0,
  leader = 1,
  elr = "",
  lastKnownElr = "",
  includeElrFields = true,
} = {}) {
  const elrFields = includeElrFields
    ? ` Elr:${elr ? ` ${elr}` : ""} LastKnownElr:${lastKnownElr ? ` ${lastKnownElr}` : ""}`
    : "";
  return `Topic: ${topic} Partition: ${partition} Leader: ${leader} Replicas: 1 Isr: 1${elrFields}`;
}

function validOutput() {
  return [
    summaryLine(),
    ...[0, 1, 2, 3, 4, 5].map((partition) => partitionLine({ partition })),
  ].join("\n");
}

function createExecutor(result = {
  stdout: validOutput(),
  stderr: "",
  exitCode: 0,
}) {
  return jest.fn().mockResolvedValue(result);
}

test("verifies the configured topic ID and six healthy Kafka 3.9.1 partitions using the fixed command", async () => {
  const executeCommand = createExecutor();

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).resolves.toEqual({
    topic: HISTORY_TOPIC,
    topicId: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
    partitionCount: 6,
    partitionIds: [0, 1, 2, 3, 4, 5],
  });

  expect(executeCommand).toHaveBeenCalledTimes(1);
  expect(executeCommand).toHaveBeenCalledWith(
    "docker",
    [
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
    ],
    {
      encoding: "utf8",
      maxBuffer: 65536,
      shell: false,
      timeout: HISTORY_SMOKE_TOPIC_PREFLIGHT_TIMEOUT_MS,
    },
  );
});

test("rejects a topic ID that differs from the configured expected identity", async () => {
  const executeCommand = createExecutor({
    stdout: validOutput().replace(
      FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
      "abcdefghijklmnopqrstuv",
    ),
    stderr: "",
    exitCode: 0,
  });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).rejects.toThrow("does not match the configured smoke identity");
});

test.each([
  ["unexpected summary topic", validOutput().replace(
    `Topic: ${HISTORY_TOPIC} TopicId:`,
    "Topic: crypto-prices TopicId:",
  )],
  ["unexpected partition topic", validOutput().replace(
    `Topic: ${HISTORY_TOPIC} Partition: 2`,
    "Topic: crypto-prices Partition: 2",
  )],
  ["wrong declared partition count", validOutput().replace(
    "PartitionCount: 6",
    "PartitionCount: 5",
  )],
  ["malformed topic ID", validOutput().replace(
    FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
    "not-a-topic-id",
  )],
  ["duplicate topic ID field", validOutput().replace(
    "Configs:",
    `Configs: TopicId: ${FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID}`,
  )],
  ["missing partition", validOutput().replace(`\n${partitionLine({ partition: 5 })}`, "")],
  ["duplicate partition", validOutput().replace(
    partitionLine({ partition: 5 }),
    partitionLine({ partition: 4 }),
  )],
  ["unexpected partition", validOutput().replace(
    partitionLine({ partition: 5 }),
    partitionLine({ partition: 6 }),
  )],
  ["missing leader", validOutput().replace(
    "Leader: 1 ",
    "Unavailable: 1 ",
  )],
  ["unavailable leader", validOutput().replace(
    "Partition: 3 Leader: 1",
    "Partition: 3 Leader: -1",
  )],
  ["unexpected trailing metadata", validOutput().replace(
    "LastKnownElr:",
    "LastKnownElr: Other: value",
  )],
  ["malformed ELR value", validOutput().replace(
    "Elr: LastKnownElr:",
    "Elr: broker LastKnownElr:",
  )],
  ["malformed ELR field ordering", validOutput().replace(
    "Elr: LastKnownElr:",
    "LastKnownElr: Elr:",
  )],
  ["duplicate summary metadata", `${validOutput()}\n${summaryLine()}`],
  ["unexpected text", `${validOutput()}\nwarning: extra output`],
  ["empty output", " \n "],
])("rejects %s", async (_label, stdout) => {
  const executeCommand = createExecutor({ stdout, stderr: "", exitCode: 0 });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).rejects.toThrow("invalid or ambiguous metadata");
});

test("rejects a nonzero command exit code", async () => {
  const executeCommand = createExecutor({
    stdout: validOutput(),
    stderr: "",
    exitCode: 1,
  });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).rejects.toThrow("preflight command failed");
});

test("rejects a command result that carries an execution error", async () => {
  const executeCommand = createExecutor({
    stdout: validOutput(),
    stderr: "",
    exitCode: 0,
    error: new Error("private execution error"),
  });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).rejects.toThrow("preflight command failed");
});

test.each(["warning", " ", "\n"])("rejects nonempty stderr %j", async (stderr) => {
  const executeCommand = createExecutor({
    stdout: validOutput(),
    stderr,
    exitCode: 0,
  });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).rejects.toThrow("preflight command failed");
});

test("sanitizes executor rejection and timeout failures", async () => {
  for (const reason of [
    new Error("password=secret; private broker output"),
    Object.assign(new Error("command timed out"), { code: "ETIMEDOUT" }),
  ]) {
    const executeCommand = jest.fn().mockRejectedValue(reason);
    let error;
    try {
      await verifyHistorySmokeTopicIdentity({
        config: smokeConfig,
        executeCommand,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error.message).toBe("V2 history smoke topic-ID preflight command failed.");
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("private");
    expect(executeCommand).toHaveBeenCalledTimes(1);
  }
});

test("accepts nonempty ELR and LastKnownElr broker ID lists", async () => {
  const output = validOutput().replace(
    "Partition: 2 Leader: 1 Replicas: 1 Isr: 1 Elr: LastKnownElr:",
    "Partition: 2 Leader: 1 Replicas: 1 Isr: 1 Elr: 1,2 LastKnownElr: 1",
  );
  const executeCommand = createExecutor({
    stdout: output,
    stderr: "",
    exitCode: 0,
  });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).resolves.toMatchObject({
    topicId: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
    partitionIds: [0, 1, 2, 3, 4, 5],
  });
});

test.each([
  ["Elr", "Elr: LastKnownElr:", "Elr: 1 Elr: 2 LastKnownElr:"],
  [
    "LastKnownElr",
    "Elr: LastKnownElr:",
    "Elr: LastKnownElr: 1 LastKnownElr: 2",
  ],
])("rejects duplicate %s fields", async (_label, original, replacement) => {
  const executeCommand = createExecutor({
    stdout: validOutput().replace(original, replacement),
    stderr: "",
    exitCode: 0,
  });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).rejects.toThrow("invalid or ambiguous metadata");
});

test("continues accepting the prior partition metadata format without ELR fields", async () => {
  const output = [
    summaryLine({ configs: "cleanup.policy=delete" }),
    ...[0, 1, 2, 3, 4, 5].map((partition) =>
      partitionLine({ partition, includeElrFields: false })),
  ].join("\n");
  const executeCommand = createExecutor({
    stdout: output,
    stderr: "",
    exitCode: 0,
  });

  await expect(verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  })).resolves.toMatchObject({
    topicId: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
    partitionIds: [0, 1, 2, 3, 4, 5],
  });
});

test.each([
  ["wrong executable", "sh", HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS],
  ["wrong argument", HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND, [
    ...HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS.slice(0, -1),
    "other-topic",
  ]],
  ["extra argument", HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND, [
    ...HISTORY_SMOKE_TOPIC_PREFLIGHT_ARGS,
    "--delete",
  ]],
  ["missing arguments", HISTORY_SMOKE_TOPIC_PREFLIGHT_COMMAND, []],
])("does not approve a %s", (_label, command, args) => {
  expect(isApprovedHistorySmokeTopicCommand(command, args)).toBe(false);
});

test("rejects missing or inactive smoke configuration before invoking the executor", async () => {
  const executeCommand = createExecutor();

  await expect(verifyHistorySmokeTopicIdentity({
    config: { ...smokeConfig, firstRunSmoke: { enabled: false } },
    executeCommand,
  })).rejects.toThrow("Invalid V2 history first-run smoke topic-ID preflight configuration");
  await expect(verifyHistorySmokeTopicIdentity({
    config: {
      ...smokeConfig,
      kafka: { ...smokeConfig.kafka, expectedTopicId: "abcdefghijklmnopqrstuv" },
    },
    executeCommand,
  })).rejects.toThrow("Invalid V2 history first-run smoke topic-ID preflight configuration");
  expect(executeCommand).not.toHaveBeenCalled();
});

test("returns only a sanitized verification summary", async () => {
  const executeCommand = createExecutor({
    stdout: validOutput().replace(
      "Configs:",
      "Configs: private=not-for-result",
    ),
    stderr: "",
    exitCode: 0,
  });

  const result = await verifyHistorySmokeTopicIdentity({
    config: smokeConfig,
    executeCommand,
  });
  expect(result).not.toHaveProperty("stdout");
  expect(result).not.toHaveProperty("stderr");
  expect(JSON.stringify(result)).not.toContain("not-for-result");
  expect(Object.isFrozen(result)).toBe(true);
});

