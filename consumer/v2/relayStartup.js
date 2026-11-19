const { verifyV1ClusterIdentity } = require("./relayIdentityGuard");
const { verifyV1TopicId } = require("./relayTopicPreflight");
const { verifyV2Destination } = require("./relayDestinationGuard");

function createRelayStartup({
  relayConfig,
  admin,
  destinationAdmin,
  executeCommand,
  createRunner,
}) {
  if (!relayConfig || relayConfig.v1Topic !== "crypto-prices" ||
      !relayConfig.sourceIdentity || !relayConfig.destinationIdentity) {
    throw new Error("Invalid validated relay configuration.");
  }
  if (!admin || typeof admin.connect !== "function" ||
      typeof admin.disconnect !== "function" ||
      typeof admin.describeCluster !== "function") {
    throw new Error("Invalid V1 Kafka admin client.");
  }
  if (!destinationAdmin || typeof destinationAdmin.connect !== "function" ||
      typeof destinationAdmin.disconnect !== "function" ||
      typeof destinationAdmin.describeCluster !== "function" ||
      typeof destinationAdmin.fetchTopicMetadata !== "function") {
    throw new Error("Invalid V2 Kafka admin client.");
  }
  if (typeof executeCommand !== "function") {
    throw new Error("Invalid topic preflight command executor.");
  }
  if (typeof createRunner !== "function") {
    throw new Error("Invalid relay runner factory.");
  }

  let startPromise;
  let stopPromise;
  let runner;
  let adminConnectionAttempted = false;
  let destinationAdminConnectionAttempted = false;
  let adminDisconnectPromise;
  let destinationAdminDisconnectPromise;
  let runnerStopPromise;
  let stopRequested = false;

  function disconnectAdmin() {
    if (!adminConnectionAttempted) return Promise.resolve();
    if (!adminDisconnectPromise) {
      adminDisconnectPromise = Promise.resolve().then(() => admin.disconnect());
    }
    return adminDisconnectPromise;
  }

  function disconnectDestinationAdmin() {
    if (!destinationAdminConnectionAttempted) return Promise.resolve();
    if (!destinationAdminDisconnectPromise) {
      destinationAdminDisconnectPromise = Promise.resolve()
        .then(() => destinationAdmin.disconnect());
    }
    return destinationAdminDisconnectPromise;
  }

  function stopRunner() {
    if (!runner) return Promise.resolve();
    if (!runnerStopPromise) {
      runnerStopPromise = Promise.resolve().then(() => runner.stop());
    }
    return runnerStopPromise;
  }

  async function cleanup() {
    const failures = [];
    try {
      await stopRunner();
    } catch {
      failures.push("relay runner stop");
    }
    try {
      await disconnectAdmin();
    } catch {
      failures.push("V1 Kafka admin disconnect");
    }
    try {
      await disconnectDestinationAdmin();
    } catch {
      failures.push("V2 Kafka admin disconnect");
    }
    return failures;
  }

  function start() {
    if (stopRequested) return Promise.reject(new Error("Relay startup has been stopped."));
    if (startPromise) return startPromise;

    startPromise = (async () => {
      let stage = "Kafka admin connection";
      try {
        adminConnectionAttempted = true;
        await admin.connect();
        if (stopRequested) throw new Error("Startup cancelled.");

        stage = "V2 Kafka admin connection";
        destinationAdminConnectionAttempted = true;
        await destinationAdmin.connect();
        if (stopRequested) throw new Error("Startup cancelled.");

        stage = "V1 topic-ID preflight";
        await verifyV1TopicId(relayConfig, executeCommand);
        if (stopRequested) throw new Error("Startup cancelled.");

        stage = "V1 cluster-ID verification";
        await verifyV1ClusterIdentity(admin, relayConfig);
        if (stopRequested) throw new Error("Startup cancelled.");

        stage = "V2 destination identity verification";
        await verifyV2Destination(
          destinationAdmin,
          relayConfig,
          relayConfig.destinationIdentity.clusterId,
        );
        if (stopRequested) throw new Error("Startup cancelled.");

        stage = "Kafka admin disconnect";
        const adminDisconnectFailures = [];
        try {
          await disconnectAdmin();
        } catch {
          adminDisconnectFailures.push("V1 Kafka admin disconnect");
        }
        try {
          await disconnectDestinationAdmin();
        } catch {
          adminDisconnectFailures.push("V2 Kafka admin disconnect");
        }
        if (adminDisconnectFailures.length) {
          throw new Error("Kafka admin cleanup failed.");
        }
        if (stopRequested) throw new Error("Startup cancelled.");

        stage = "relay runner creation";
        runner = createRunner(relayConfig);
        if (!runner || typeof runner.start !== "function" ||
            typeof runner.stop !== "function") {
          throw new Error("Invalid relay runner.");
        }
        if (stopRequested) throw new Error("Startup cancelled.");

        stage = "relay runner startup";
        await runner.start();
        return runner;
      } catch {
        const failures = await cleanup();
        if (stopRequested) {
          throw new Error(
            `Relay startup cancelled.${failures.length ? ` Cleanup failed: ${failures.join(", ")}.` : ""}`,
          );
        }
        throw new Error(
          `Relay startup failed during ${stage}.${failures.length ? ` Cleanup failed: ${failures.join(", ")}.` : ""}`,
        );
      }
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      if (startPromise) {
        try {
          await startPromise;
        } catch {
          // Startup reports its own failure; continue cleanup idempotently.
        }
      }
      const failures = await cleanup();
      if (failures.length) {
        throw new Error(`Relay shutdown cleanup failed: ${failures.join(", ")}.`);
      }
    })();
    return stopPromise;
  }

  return { start, stop };
}

module.exports = { createRelayStartup };
