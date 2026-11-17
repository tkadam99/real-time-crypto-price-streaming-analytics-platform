const { randomUUID } = require("node:crypto");
const net = require("node:net");

function parseLoopbackBroker(broker) {
  if (typeof broker !== "string") {
    throw new Error("KAFKA_INTEGRATION_BROKER must be a single loopback host and port.");
  }
  const match = /^(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/i.exec(broker);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error("KAFKA_INTEGRATION_BROKER must be a single loopback host and valid port.");
  }
  return { host: match[1].toLowerCase(), port: Number(match[2]) };
}

function getKafkaIntegrationBroker(env = process.env) {
  if (!env.KAFKA_INTEGRATION_BROKER || !env.MONGO_INTEGRATION_URI) return null;
  if (env.ALLOW_DESTRUCTIVE_INTEGRATION_TESTS !== "true") {
    throw new Error("Kafka integration tests require ALLOW_DESTRUCTIVE_INTEGRATION_TESTS=true.");
  }
  parseLoopbackBroker(env.KAFKA_INTEGRATION_BROKER);
  return env.KAFKA_INTEGRATION_BROKER;
}

function createKafkaConnectionOptions(broker, connect = net.connect) {
  const configured = parseLoopbackBroker(broker);
  const expectedHost = configured.host === "[::1]" ? "::1" : "127.0.0.1";
  return {
    // KafkaJS splits bootstrap addresses on ":", so use an alias for IPv6.
    brokers: [`${configured.host === "[::1]" ? "localhost" : configured.host}:${configured.port}`],
    socketFactory: ({ host, port, ssl, onConnect }) => {
      if (
        typeof host !== "string"
        || !["localhost", expectedHost].includes(host.toLowerCase())
        || Number(port) !== configured.port
        || ssl
      ) {
        throw new Error("Refusing Kafka connection to an unapproved advertised broker.");
      }
      const localHost = host.toLowerCase() === "localhost"
        ? expectedHost
        : host.toLowerCase();
      const socket = connect({ host: localHost, port: configured.port }, onConnect);
      socket.setKeepAlive(true, 60000);
      return socket;
    },
  };
}

function isGeneratedKafkaResourceName(name) {
  return typeof name === "string" && /^test-[a-z][a-z0-9-]{0,40}-[0-9a-f]{32}$/.test(name);
}

function createKafkaTestResources() {
  const topics = new Set();
  const groups = new Set();

  function generate(prefix, registry) {
    if (typeof prefix !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(prefix)) {
      throw new Error("Kafka integration test resource prefix is invalid.");
    }
    const name = `test-${prefix}-${randomUUID().replace(/-/g, "")}`;
    registry.add(name);
    return name;
  }

  function requireRegistered(name, registry) {
    if (!isGeneratedKafkaResourceName(name) || !registry.has(name)) {
      throw new Error("Refusing operation on an unregistered Kafka integration test resource.");
    }
  }

  return {
    createTopicName: (prefix) => generate(prefix, topics),
    createGroupName: (prefix) => generate(prefix, groups),
    async deleteTopic(admin, topic) {
      requireRegistered(topic, topics);
      topics.delete(topic);
      return admin.deleteTopics({ topics: [topic] });
    },
    async deleteGroups(admin, groupIds) {
      if (!Array.isArray(groupIds) || !groupIds.length || new Set(groupIds).size !== groupIds.length) {
        throw new Error("Kafka integration test groups must be a non-empty list of unique names.");
      }
      const names = [...groupIds];
      names.forEach((name) => requireRegistered(name, groups));
      names.forEach((name) => groups.delete(name));
      return admin.deleteGroups(names);
    },
    async setOffsets(admin, { groupId, topic, partitions }) {
      requireRegistered(groupId, groups);
      requireRegistered(topic, topics);
      return admin.setOffsets({ groupId, topic, partitions });
    },
  };
}

module.exports = {
  createKafkaConnectionOptions,
  createKafkaTestResources,
  getKafkaIntegrationBroker,
  isGeneratedKafkaResourceName,
};
