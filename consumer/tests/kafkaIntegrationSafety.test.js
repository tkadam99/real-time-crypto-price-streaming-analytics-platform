const {
  createKafkaConnectionOptions,
  createKafkaTestResources,
  getKafkaIntegrationBroker,
  isGeneratedKafkaResourceName,
} = require("../../test-utils/kafkaIntegrationSafety");

describe("Kafka integration test safety", () => {
  const optedIn = {
    KAFKA_INTEGRATION_BROKER: "localhost:9092",
    MONGO_INTEGRATION_URI: "mongodb://localhost:27017",
    ALLOW_DESTRUCTIVE_INTEGRATION_TESTS: "true",
  };

  test("skips if either integration endpoint is missing", () => {
    expect(getKafkaIntegrationBroker({ ...optedIn, KAFKA_INTEGRATION_BROKER: "" })).toBeNull();
    expect(getKafkaIntegrationBroker({ ...optedIn, MONGO_INTEGRATION_URI: "" })).toBeNull();
    expect(getKafkaIntegrationBroker({})).toBeNull();
  });

  test("requires explicit destructive-test opt-in when both endpoints are set", () => {
    expect(() => getKafkaIntegrationBroker({
      KAFKA_INTEGRATION_BROKER: optedIn.KAFKA_INTEGRATION_BROKER,
      MONGO_INTEGRATION_URI: optedIn.MONGO_INTEGRATION_URI,
    }))
      .toThrow("ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true");
    expect(() => getKafkaIntegrationBroker({
      ...optedIn, ALLOW_DESTRUCTIVE_INTEGRATION_TESTS: "false",
    })).toThrow("ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true");
  });

  test.each(["localhost:9092", "127.0.0.1:1", "[::1]:65535"])(
    "accepts a single loopback broker: %s",
    (broker) => {
      expect(getKafkaIntegrationBroker({ ...optedIn, KAFKA_INTEGRATION_BROKER: broker })).toBe(broker);
    }
  );

  test.each([
    "broker.example.com:9092",
    "192.168.1.1:9092",
    "localhost:9092,127.0.0.1:9092",
    "localhost:9092,remote.example:9092",
    "localhost",
    "localhost:",
    "localhost:0",
    "localhost:65536",
    "localhost:-1",
    "localhost:abc",
    "::1:9092",
    "[::1]:",
    "localhost:9092/path",
    " localhost:9092",
  ])("rejects remote, multiple or malformed broker %s", (broker) => {
    expect(() => getKafkaIntegrationBroker({ ...optedIn, KAFKA_INTEGRATION_BROKER: broker }))
      .toThrow("single loopback");
  });

  test.each([
    ["localhost:9092", "localhost:9092", "127.0.0.1"],
    ["127.0.0.1:9092", "127.0.0.1:9092", "127.0.0.1"],
    ["[::1]:9092", "localhost:9092", "::1"],
  ])("connects %s to a literal local address", (broker, bootstrap, expectedHost) => {
    const socket = { setKeepAlive: jest.fn() };
    const connect = jest.fn().mockReturnValue(socket);
    const onConnect = jest.fn();
    const options = createKafkaConnectionOptions(broker, connect);
    expect(options.brokers).toEqual([bootstrap]);
    expect(options.socketFactory({ host: "localhost", port: 9092, onConnect })).toBe(socket);
    expect(connect).toHaveBeenCalledWith({ host: expectedHost, port: 9092 }, onConnect);
    expect(socket.setKeepAlive).toHaveBeenCalledWith(true, 60000);
  });

  test.each([
    { host: "broker.example.com", port: 9092 },
    { host: "127.0.0.1", port: 9093 },
    { host: "::1", port: 9092 },
    { host: "localhost", port: 9092, ssl: true },
  ])("rejects unsafe advertised broker %j before connecting", (destination) => {
    const connect = jest.fn();
    const { socketFactory } = createKafkaConnectionOptions("localhost:9092", connect);
    expect(() => socketFactory(destination)).toThrow("unapproved advertised broker");
    expect(connect).not.toHaveBeenCalled();
  });

  test("generates unique registered topic and group names", () => {
    const resources = createKafkaTestResources();
    const names = [
      resources.createTopicName("price"),
      resources.createTopicName("price"),
      resources.createGroupName("price"),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(isGeneratedKafkaResourceName)).toBe(true);
    expect(isGeneratedKafkaResourceName("crypto-prices")).toBe(false);
    expect(() => resources.createTopicName("Bad/name")).toThrow("prefix is invalid");
  });

  test("deletes only registered resources and refuses repeated cleanup", async () => {
    const resources = createKafkaTestResources();
    const topic = resources.createTopicName("price");
    const group = resources.createGroupName("price");
    const admin = { deleteTopics: jest.fn(), deleteGroups: jest.fn() };
    const forged = `test-price-${"a".repeat(32)}`;
    expect(isGeneratedKafkaResourceName(forged)).toBe(true);

    await expect(resources.deleteTopic(admin, forged)).rejects.toThrow("unregistered");
    await expect(resources.deleteGroups(admin, [group, forged])).rejects.toThrow("unregistered");
    expect(admin.deleteTopics).not.toHaveBeenCalled();
    expect(admin.deleteGroups).not.toHaveBeenCalled();

    await resources.deleteGroups(admin, [group]);
    await resources.deleteTopic(admin, topic);
    expect(admin.deleteGroups).toHaveBeenCalledWith([group]);
    expect(admin.deleteTopics).toHaveBeenCalledWith({ topics: [topic] });
    await expect(resources.deleteGroups(admin, [group])).rejects.toThrow("unregistered");
    await expect(resources.deleteTopic(admin, topic)).rejects.toThrow("unregistered");
    expect(admin.deleteGroups).toHaveBeenCalledTimes(1);
    expect(admin.deleteTopics).toHaveBeenCalledTimes(1);
  });

  test("rejects offset changes unless both topic and group are registered", async () => {
    const resources = createKafkaTestResources();
    const anotherRun = createKafkaTestResources();
    const topic = resources.createTopicName("price");
    const groupId = resources.createGroupName("price");
    const otherTopic = anotherRun.createTopicName("price");
    const otherGroup = anotherRun.createGroupName("price");
    const partitions = [{ partition: 0, offset: "0" }];
    const admin = { setOffsets: jest.fn() };

    await expect(resources.setOffsets(admin, { groupId, topic: otherTopic, partitions }))
      .rejects.toThrow("unregistered");
    await expect(resources.setOffsets(admin, { groupId: otherGroup, topic, partitions }))
      .rejects.toThrow("unregistered");
    expect(admin.setOffsets).not.toHaveBeenCalled();
    await resources.setOffsets(admin, { groupId, topic, partitions });
    expect(admin.setOffsets).toHaveBeenCalledWith({ groupId, topic, partitions });
    await resources.deleteTopic({ deleteTopics: jest.fn() }, topic);
    await expect(resources.setOffsets(admin, { groupId, topic, partitions })).rejects.toThrow("unregistered");
    expect(admin.setOffsets).toHaveBeenCalledTimes(1);
  });

  test("propagates topic deletion failure without allowing a repeated deletion", async () => {
    const resources = createKafkaTestResources();
    const topic = resources.createTopicName("price");
    const failure = new Error("delete failed");
    const admin = { deleteTopics: jest.fn().mockRejectedValue(failure) };
    await expect(resources.deleteTopic(admin, topic)).rejects.toBe(failure);
    await expect(resources.deleteTopic(admin, topic)).rejects.toThrow("unregistered");
    expect(admin.deleteTopics).toHaveBeenCalledTimes(1);
  });

  test("propagates group deletion failure without allowing a repeated deletion", async () => {
    const resources = createKafkaTestResources();
    const group = resources.createGroupName("price");
    const failure = new Error("group deletion failed");
    const admin = { deleteGroups: jest.fn().mockRejectedValue(failure) };

    await expect(resources.deleteGroups(admin, [group])).rejects.toBe(failure);
    await expect(resources.deleteGroups(admin, [group])).rejects.toThrow("unregistered");
    expect(admin.deleteGroups).toHaveBeenCalledTimes(1);
  });

  test("propagates partial group deletion failure while allowing separate topic cleanup", async () => {
    const resources = createKafkaTestResources();
    const topic = resources.createTopicName("price");
    const firstGroup = resources.createGroupName("price");
    const secondGroup = resources.createGroupName("price");
    const failure = Object.assign(new Error("Error in DeleteGroups"), {
      groups: [{ groupId: secondGroup, errorCode: 30 }],
    });
    const admin = {
      deleteGroups: jest.fn().mockRejectedValue(failure),
      deleteTopics: jest.fn().mockResolvedValue(),
      setOffsets: jest.fn(),
    };

    await expect(resources.deleteGroups(admin, [firstGroup, secondGroup])).rejects.toBe(failure);
    await expect(resources.deleteGroups(admin, [firstGroup])).rejects.toThrow("unregistered");
    await expect(resources.deleteGroups(admin, [secondGroup])).rejects.toThrow("unregistered");
    await expect(resources.setOffsets(admin, {
      groupId: secondGroup, topic, partitions: [{ partition: 0, offset: "0" }],
    })).rejects.toThrow("unregistered");
    await resources.deleteTopic(admin, topic);
    expect(admin.deleteGroups).toHaveBeenCalledTimes(1);
    expect(admin.setOffsets).not.toHaveBeenCalled();
    expect(admin.deleteTopics).toHaveBeenCalledWith({ topics: [topic] });
  });

  test("rejects resources from another registry and resources of the wrong kind", async () => {
    const resources = createKafkaTestResources();
    const otherResources = createKafkaTestResources();
    const topic = resources.createTopicName("price");
    const group = resources.createGroupName("price");
    const otherTopic = otherResources.createTopicName("price");
    const otherGroup = otherResources.createGroupName("price");
    const admin = { deleteTopics: jest.fn(), deleteGroups: jest.fn() };

    await expect(resources.deleteTopic(admin, otherTopic)).rejects.toThrow("unregistered");
    await expect(resources.deleteGroups(admin, [otherGroup])).rejects.toThrow("unregistered");
    await expect(resources.deleteTopic(admin, group)).rejects.toThrow("unregistered");
    await expect(resources.deleteGroups(admin, [topic])).rejects.toThrow("unregistered");
    expect(admin.deleteTopics).not.toHaveBeenCalled();
    expect(admin.deleteGroups).not.toHaveBeenCalled();
  });

  test("rejects repeated deletion while the first attempt is pending", async () => {
    const resources = createKafkaTestResources();
    const topic = resources.createTopicName("price");
    let finish;
    const admin = {
      deleteTopics: jest.fn(() => new Promise((resolve) => { finish = resolve; })),
    };
    const pending = resources.deleteTopic(admin, topic);

    await expect(resources.deleteTopic(admin, topic)).rejects.toThrow("unregistered");
    finish();
    await pending;
    expect(admin.deleteTopics).toHaveBeenCalledTimes(1);
  });
});
