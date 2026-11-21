const {
  FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
  LIVE_START_ACKNOWLEDGEMENT,
  loadHistoryConsumerConfig,
} = require("../v2/historyConsumerConfig");
const { verifyHistorySmokeGroup } = require("../v2/historySmokeGroupPreflight");

const GROUP_ID = "crypto-v2-history-group";
const TOPIC = "crypto-prices-v2";
const smokeConfig = loadHistoryConsumerConfig({
  V2_HISTORY_CONSUMER_ENABLED: "true",
  V2_HISTORY_LIVE_START_ACK: LIVE_START_ACKNOWLEDGEMENT,
  V2_HISTORY_FIRST_RUN_SMOKE_ENABLED: "true",
  V2_HISTORY_FIRST_RUN_SMOKE_ACK: FIRST_RUN_SMOKE_ACKNOWLEDGEMENT,
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RECORDS: "10",
  V2_HISTORY_FIRST_RUN_SMOKE_MAX_RUNTIME_MS: "60000",
  V2_HISTORY_TOPIC_ID: FIRST_RUN_SMOKE_EXPECTED_TOPIC_ID,
});

function noOffsets() {
  return [0, 1, 2, 3, 4, 5].map((partition) => ({
    partition,
    offset: "-1",
    metadata: null,
    errorCode: 0,
  }));
}

function groupDescription(overrides = {}) {
  return {
    groupId: GROUP_ID,
    state: "Empty",
    protocolType: "consumer",
    protocol: "",
    members: [],
    errorCode: 0,
    ...overrides,
  };
}

function createAdmin({
  groups = [{ groupId: GROUP_ID, protocolType: "consumer" }],
  descriptions = [groupDescription()],
  offsets = [{ topic: TOPIC, partitions: noOffsets() }],
  errors = {},
} = {}) {
  return {
    listGroups: jest.fn(async () => {
      if (errors.listGroups) throw errors.listGroups;
      return { groups };
    }),
    describeGroups: jest.fn(async () => {
      if (errors.describeGroups) throw errors.describeGroups;
      return { groups: descriptions };
    }),
    fetchOffsets: jest.fn(async () => {
      if (errors.fetchOffsets) throw errors.fetchOffsets;
      return offsets;
    }),
    connect: jest.fn(),
    disconnect: jest.fn(),
    setOffsets: jest.fn(),
    resetOffsets: jest.fn(),
    deleteGroups: jest.fn(),
    createTopics: jest.fn(),
    deleteTopics: jest.fn(),
  };
}

test("returns absent only after a successful complete no-offset response", async () => {
  const admin = createAdmin({
    groups: [{ groupId: "another-group", protocolType: "consumer" }],
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .resolves.toEqual({
      status: "absent",
      groupId: GROUP_ID,
    });

  expect(admin.listGroups).toHaveBeenCalledTimes(1);
  expect(admin.describeGroups).not.toHaveBeenCalled();
  expect(admin.fetchOffsets).toHaveBeenCalledWith({
    groupId: GROUP_ID,
    topics: [TOPIC],
    resolveOffsets: false,
  });
});

test("rejects an absent group when offsets contain a committed record", async () => {
  const admin = createAdmin({
    groups: [],
    offsets: [{
      topic: TOPIC,
      partitions: noOffsets().map((entry, index) =>
        index === 1 ? { ...entry, offset: "0" } : entry),
    }],
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow("committed or ambiguous offsets");
  expect(admin.describeGroups).not.toHaveBeenCalled();
});

test("fails closed when an absent group's offset fetch returns GROUP_ID_NOT_FOUND", async () => {
  const admin = createAdmin({
    groups: [],
    errors: {
      fetchOffsets: Object.assign(
        new Error("The group id was not found at kafka://private-broker"),
        { type: "GROUP_ID_NOT_FOUND", code: 69 },
      ),
    },
  });
  let error;
  try {
    await verifyHistorySmokeGroup({ admin, config: smokeConfig });
  } catch (caught) {
    error = caught;
  }

  expect(error.message).toBe("Unable to retrieve V2 history Kafka group offsets.");
  expect(error.message).not.toContain("GROUP_ID_NOT_FOUND");
  expect(error.message).not.toContain("private-broker");
  expect(admin.describeGroups).not.toHaveBeenCalled();
});

test.each([
  ["malformed response", null],
  ["incomplete partition coverage", [{
    topic: TOPIC,
    partitions: noOffsets().slice(0, 5),
  }]],
  ["unexpected topic", [{
    topic: "other-topic",
    partitions: noOffsets(),
  }]],
])("rejects an absent group with %s offset metadata", async (_label, offsets) => {
  const admin = createAdmin({ groups: [], offsets });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow();
  expect(admin.describeGroups).not.toHaveBeenCalled();
});

test("fails closed when offsets for an absent group are unavailable", async () => {
  const admin = createAdmin({
    groups: [],
    errors: {
      fetchOffsets: new Error("offset metadata unavailable; connection refused"),
    },
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow("Unable to retrieve V2 history Kafka group offsets.");
  expect(admin.describeGroups).not.toHaveBeenCalled();
});

test("verifies an existing empty group with no committed offsets", async () => {
  const admin = createAdmin();

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .resolves.toEqual({
      status: "existing-empty-uncommitted",
      groupId: GROUP_ID,
      topic: TOPIC,
      partitionIds: [0, 1, 2, 3, 4, 5],
    });

  expect(admin.describeGroups).toHaveBeenCalledWith([GROUP_ID]);
  expect(admin.fetchOffsets).toHaveBeenCalledWith({
    groupId: GROUP_ID,
    topics: [TOPIC],
    resolveOffsets: false,
  });
});

test("rejects an existing empty group when any partition has a committed offset", async () => {
  const admin = createAdmin({
    offsets: [{
      topic: TOPIC,
      partitions: noOffsets().map((entry, index) =>
        index === 4 ? { ...entry, offset: "17" } : entry),
    }],
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow("committed or ambiguous offsets");
});

test("accepts KafkaJS's default assigner protocol on an empty group", async () => {
  const admin = createAdmin({
    descriptions: [groupDescription({ protocol: "RoundRobinAssigner" })],
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .resolves.toMatchObject({ status: "existing-empty-uncommitted" });
});

test.each([
  "Stable",
  "PreparingRebalance",
  "CompletingRebalance",
  "Dead",
  "Unknown",
  "unexpected",
  "",
  null,
])("rejects a group state other than Empty: %s", async (state) => {
  const admin = createAdmin({
    descriptions: [groupDescription({ state })],
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow("not empty or has unexpected metadata");
  expect(admin.fetchOffsets).not.toHaveBeenCalled();
});

test("rejects groups with active members", async () => {
  const admin = createAdmin({
    descriptions: [groupDescription({
      state: "Stable",
      members: [{ memberId: "member-1" }],
    })],
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow("not empty or has unexpected metadata");
  expect(admin.fetchOffsets).not.toHaveBeenCalled();
});

test.each([
  [
    "unexpected group ID",
    [groupDescription({ groupId: "other-group" })],
    "not empty or has unexpected metadata",
  ],
  ["missing description", [], "description is malformed or ambiguous"],
  [
    "duplicate descriptions",
    [groupDescription(), groupDescription()],
    "description is malformed or ambiguous",
  ],
  [
    "unexpected protocol type",
    [groupDescription({ protocolType: "connect" })],
    "not empty or has unexpected metadata",
  ],
  [
    "unexpected protocol",
    [groupDescription({ protocol: "OtherAssigner" })],
    "not empty or has unexpected metadata",
  ],
  [
    "malformed members",
    [groupDescription({ members: null })],
    "not empty or has unexpected metadata",
  ],
  [
    "unexpected description field",
    [groupDescription({ extra: true })],
    "not empty or has unexpected metadata",
  ],
  [
    "nonzero response error",
    [groupDescription({ errorCode: 5 })],
    "not empty or has unexpected metadata",
  ],
  [
    "malformed response error",
    [groupDescription({ errorCode: undefined })],
    "not empty or has unexpected metadata",
  ],
])("rejects %s", async (_label, descriptions, expectedError) => {
  const admin = createAdmin({ descriptions });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow(expectedError);
  expect(admin.fetchOffsets).not.toHaveBeenCalled();
});

test("rejects malformed or incomplete group descriptions", async () => {
  const admin = createAdmin({ descriptions: [null] });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow("not empty or has unexpected metadata");
});

test.each([
  ["concrete offset", noOffsets().map((entry, index) =>
    index === 2 ? { ...entry, offset: "0" } : entry)],
  ["positive concrete offset", noOffsets().map((entry, index) =>
    index === 2 ? { ...entry, offset: "42" } : entry)],
  ["unknown negative offset", noOffsets().map((entry, index) =>
    index === 2 ? { ...entry, offset: "-2" } : entry)],
  ["numeric offset instead of string", noOffsets().map((entry, index) =>
    index === 2 ? { ...entry, offset: -1 } : entry)],
  ["non-null metadata with no-offset sentinel", noOffsets().map((entry, index) =>
    index === 2 ? { ...entry, metadata: "" } : entry)],
  ["missing metadata", noOffsets().map((entry, index) => {
    if (index !== 2) return entry;
    const { metadata: _metadata, ...withoutMetadata } = entry;
    return withoutMetadata;
  })],
  ["nonzero partition error", noOffsets().map((entry, index) =>
    index === 2 ? { ...entry, errorCode: 5 } : entry)],
  ["malformed partition error", noOffsets().map((entry, index) =>
    index === 2 ? { ...entry, errorCode: undefined } : entry)],
])("rejects %s", async (_label, partitions) => {
  const admin = createAdmin({
    offsets: [{ topic: TOPIC, partitions }],
  });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow("committed or ambiguous offsets");
});

test.each([
  ["malformed response", null],
  ["empty response", []],
  ["unexpected topic", [{ topic: "other-topic", partitions: noOffsets() }]],
  ["unexpected topic entry", [
    { topic: TOPIC, partitions: noOffsets() },
    { topic: "other-topic", partitions: noOffsets() },
  ]],
  ["duplicate partition", [{
    topic: TOPIC,
    partitions: [...noOffsets().slice(0, 5), { ...noOffsets()[4] }],
  }]],
  ["unexpected partition", [{
    topic: TOPIC,
    partitions: [...noOffsets().slice(0, 5), {
      partition: 6,
      offset: "-1",
      metadata: null,
    }],
  }]],
  ["missing partition", [{
    topic: TOPIC,
    partitions: noOffsets().slice(0, 5),
  }]],
  ["unexpected partition metadata", [{
    topic: TOPIC,
    partitions: noOffsets().map((entry, index) =>
      index === 0 ? { ...entry, extra: "unexpected" } : entry),
  }]],
])("rejects %s in offset metadata", async (_label, offsets) => {
  const admin = createAdmin({ offsets });

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow();
});

test.each([
  ["missing groups", {}],
  ["non-array groups", { groups: null }],
  ["malformed group entry", { groups: [{ groupId: GROUP_ID }] }],
  ["empty identity", { groups: [{ groupId: "", protocolType: "consumer" }] }],
  ["noncanonical identity", {
    groups: [{ groupId: ` ${GROUP_ID}`, protocolType: "consumer" }],
  }],
  ["unexpected group metadata", {
    groups: [{ groupId: GROUP_ID, protocolType: "consumer", state: "Empty" }],
  }],
  ["duplicate group identity", {
    groups: [
      { groupId: GROUP_ID, protocolType: "consumer" },
      { groupId: GROUP_ID, protocolType: "consumer" },
    ],
  }],
  ["unexpected target protocol", {
    groups: [{ groupId: GROUP_ID, protocolType: "connect" }],
  }],
])("rejects malformed or ambiguous group-list response: %s", async (_label, response) => {
  const admin = createAdmin();
  admin.listGroups.mockResolvedValue(response);

  await expect(verifyHistorySmokeGroup({ admin, config: smokeConfig }))
    .rejects.toThrow();
  expect(admin.describeGroups).not.toHaveBeenCalled();
  expect(admin.fetchOffsets).not.toHaveBeenCalled();
});

test.each(["listGroups", "describeGroups", "fetchOffsets"])(
  "sanitizes %s API rejection without treating it as proof of absence",
  async (method) => {
    const admin = createAdmin({
      errors: {
        [method]: new Error("kafka://private-broker password=secret"),
      },
    });
    let error;
    try {
      await verifyHistorySmokeGroup({ admin, config: smokeConfig });
    } catch (caught) {
      error = caught;
    }

    expect(error.message).toMatch(/Unable to retrieve V2 history Kafka/);
    expect(error.message).not.toContain("private-broker");
    expect(error.message).not.toContain("secret");
    if (method === "listGroups") {
      expect(admin.describeGroups).not.toHaveBeenCalled();
      expect(admin.fetchOffsets).not.toHaveBeenCalled();
    }
  },
);

test("rejects unpinned or non-smoke configuration before calling the admin API", async () => {
  const admin = createAdmin();
  const invalidConfigs = [
    { ...smokeConfig, enabled: false },
    { ...smokeConfig, liveStartAcknowledged: false },
    { ...smokeConfig, firstRunSmoke: { ...smokeConfig.firstRunSmoke, enabled: false } },
    { ...smokeConfig, firstRunSmoke: { ...smokeConfig.firstRunSmoke, maxRecords: 101 } },
    { ...smokeConfig, kafka: { ...smokeConfig.kafka, topic: "other-topic" } },
    { ...smokeConfig, kafka: { ...smokeConfig.kafka, broker: "other-broker:9092" } },
    { ...smokeConfig, kafka: { ...smokeConfig.kafka, clusterId: "other-cluster" } },
    { ...smokeConfig, kafka: { ...smokeConfig.kafka, expectedTopicId: "other-topic-id" } },
    { ...smokeConfig, consumer: { ...smokeConfig.consumer, groupId: "other-group" } },
  ];

  for (const config of invalidConfigs) {
    await expect(verifyHistorySmokeGroup({ admin, config }))
      .rejects.toThrow("Invalid V2 history smoke group preflight configuration");
  }
  expect(admin.listGroups).not.toHaveBeenCalled();
});

test("uses no mutating Kafka APIs or consumer lifecycle operations", async () => {
  const consumer = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn(),
    commitOffsets: jest.fn(),
    seek: jest.fn(),
  };
  for (const groups of [[], [{ groupId: GROUP_ID, protocolType: "consumer" }]]) {
    const admin = createAdmin({ groups });
    await verifyHistorySmokeGroup({ admin, config: smokeConfig, consumer });

    for (const method of [
      "connect",
      "disconnect",
      "setOffsets",
      "resetOffsets",
      "deleteGroups",
      "createTopics",
      "deleteTopics",
    ]) {
      expect(admin[method]).not.toHaveBeenCalled();
    }
  }
  for (const method of [
    "connect",
    "disconnect",
    "subscribe",
    "commitOffsets",
    "seek",
  ]) {
    expect(consumer[method]).not.toHaveBeenCalled();
  }
});

