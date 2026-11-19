const { execFile } = require("child_process");
const { Kafka } = require("kafkajs");
const { loadRelayConfig } = require("./relayConfig");
const { createRelayRunner, RELAY_CONSUMER_GROUP_ID } = require("./relayRunner");
const { createRelayStartup } = require("./relayStartup");
const {
  TOPIC_PREFLIGHT_ARGS,
  TOPIC_PREFLIGHT_COMMAND,
} = require("./relayTopicPreflight");

const PREFLIGHT_TIMEOUT_MS = 15000;
const PREFLIGHT_MAX_BUFFER = 1024 * 1024;

function isApprovedCommand(command, args) {
  return command === TOPIC_PREFLIGHT_COMMAND &&
    Array.isArray(args) &&
    args.length === TOPIC_PREFLIGHT_ARGS.length &&
    args.every((arg, index) => arg === TOPIC_PREFLIGHT_ARGS[index]);
}

function createBoundedTopicCommandExecutor(execFileImpl = execFile) {
  if (typeof execFileImpl !== "function") {
    throw new Error("Invalid process command executor.");
  }

  return (command, args) => {
    if (!isApprovedCommand(command, args)) {
      return Promise.reject(new Error("Unsupported topic preflight command."));
    }

    return new Promise((resolve, reject) => {
      execFileImpl(
        TOPIC_PREFLIGHT_COMMAND,
        [...TOPIC_PREFLIGHT_ARGS],
        {
          encoding: "utf8",
          maxBuffer: PREFLIGHT_MAX_BUFFER,
          shell: false,
          timeout: PREFLIGHT_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error("Topic preflight command failed."));
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        },
      );
    });
  };
}

function createRelayApplication({
  env = process.env,
  KafkaConstructor = Kafka,
  execFileImpl = execFile,
  executeCommand,
  processObject = process,
  logger = console,
} = {}) {
  const relayConfig = loadRelayConfig(env);
  if (typeof KafkaConstructor !== "function") {
    throw new Error("Invalid Kafka client constructor.");
  }

  const v1Kafka = new KafkaConstructor({
    clientId: "crypto-v2-relay-v1",
    brokers: [relayConfig.v1KafkaBroker],
  });
  const v2Kafka = new KafkaConstructor({
    clientId: "crypto-v2-relay-v2",
    brokers: [relayConfig.v2KafkaBroker],
  });
  const admin = v1Kafka.admin();
  const destinationAdmin = v2Kafka.admin();
  const consumer = v1Kafka.consumer({
    groupId: relayConfig.consumerGroupId,
    allowAutoTopicCreation: false,
  });
  const producer = v2Kafka.producer();
  const runCommand = executeCommand === undefined
    ? createBoundedTopicCommandExecutor(execFileImpl)
    : executeCommand;

  let shutdownRequested = false;
  let signalController;

  function createManagedRunner(config) {
    const relayRunner = createRelayRunner({
      consumer,
      producer,
      sourceIdentity: config.sourceIdentity,
      v2PartitionCount: config.v2PartitionCount,
    });
    let producerConnectAttempted = false;
    let consumerConnectAttempted = false;
    let startPromise;
    let stopPromise;

    function start() {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        if (shutdownRequested) throw new Error("Relay shutdown requested.");
        producerConnectAttempted = true;
        await producer.connect();
        if (shutdownRequested) throw new Error("Relay shutdown requested.");
        consumerConnectAttempted = true;
        await consumer.connect();
        if (shutdownRequested) throw new Error("Relay shutdown requested.");
        await relayRunner.start();
      })();
      return startPromise;
    }

    function stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        const failures = [];
        try {
          await relayRunner.stop();
        } catch {
          failures.push("relay consumer stop");
        }
        if (consumerConnectAttempted) {
          try {
            await consumer.disconnect();
          } catch {
            failures.push("V1 consumer disconnect");
          }
        }
        if (producerConnectAttempted) {
          try {
            await producer.disconnect();
          } catch {
            failures.push("V2 producer disconnect");
          }
        }
        if (failures.length) {
          throw new Error(`Relay client cleanup failed: ${failures.join(", ")}.`);
        }
      })();
      return stopPromise;
    }

    return { start, stop };
  }

  const startup = createRelayStartup({
    relayConfig,
    admin,
    destinationAdmin,
    executeCommand: runCommand,
    createRunner: createManagedRunner,
  });

  function start() {
    return startup.start();
  }

  function stop() {
    shutdownRequested = true;
    return startup.stop();
  }

  function installSignalHandlers() {
    if (!processObject || typeof processObject.on !== "function" ||
        typeof processObject.removeListener !== "function") {
      throw new Error("Invalid process signal handler.");
    }
    if (signalController && !signalController.removed) return signalController;

    let signal = null;
    let shutdownPromise;
    let removed = false;

    function remove() {
      if (removed) return;
      removed = true;
      processObject.removeListener("SIGINT", onSigint);
      processObject.removeListener("SIGTERM", onSigterm);
    }

    function handleSignal(receivedSignal) {
      if (shutdownPromise) return shutdownPromise;
      signal = receivedSignal;
      shutdownPromise = (async () => {
        try {
          await stop();
        } catch {
          if (logger && typeof logger.error === "function") {
            logger.error("V2 relay shutdown failed.");
          }
          processObject.exitCode = 1;
        } finally {
          if (processObject.exitCode === undefined) {
            processObject.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
          }
          remove();
        }
      })();
      return shutdownPromise;
    }

    function onSigint() {
      void handleSignal("SIGINT");
    }

    function onSigterm() {
      void handleSignal("SIGTERM");
    }

    processObject.on("SIGINT", onSigint);
    processObject.on("SIGTERM", onSigterm);
    signalController = {
      remove,
      get removed() {
        return removed;
      },
      get signal() {
        return signal;
      },
      waitForShutdown() {
        return shutdownPromise || Promise.resolve();
      },
    };
    return signalController;
  }

  return {
    relayConfig,
    start,
    stop,
    installSignalHandlers,
  };
}

async function runRelay(options = {}) {
  const processObject = options.processObject || process;
  const logger = options.logger || console;
  let application;
  try {
    application = createRelayApplication({
      ...options,
      processObject,
      logger,
    });
  } catch {
    if (logger && typeof logger.error === "function") {
      logger.error("V2 relay configuration or client setup failed.");
    }
    processObject.exitCode = 1;
    return null;
  }

  let signals;
  try {
    signals = application.installSignalHandlers();
    await application.start();
    return application;
  } catch {
    if (signals && signals.signal) {
      await signals.waitForShutdown();
      return application;
    }
    if (logger && typeof logger.error === "function") {
      logger.error("V2 relay startup failed.");
    }
    processObject.exitCode = 1;
    try {
      await application.stop();
    } catch {
      if (logger && typeof logger.error === "function") {
        logger.error("V2 relay cleanup failed.");
      }
    }
    if (signals) signals.remove();
    return null;
  }
}

function main() {
  return runRelay({ env: process.env, processObject: process, logger: console });
}

if (require.main === module) {
  void main().catch(() => {
    console.error("V2 relay exited after an unexpected failure.");
    process.exitCode = 1;
  });
}

module.exports = {
  PREFLIGHT_TIMEOUT_MS,
  createBoundedTopicCommandExecutor,
  createRelayApplication,
  runRelay,
  main,
};
