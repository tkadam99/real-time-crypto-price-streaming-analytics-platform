const { connectDB, closeDB } = require("./mongoClient");
const {
  startConsumer,
  beginConsumerShutdown,
  stopConsumer,
  disconnectConsumer,
  waitForActiveMessages,
  hasShutdownProcessingFailure,
} = require("./kafkaConsumer");

// Includes startup, Kafka drain/disconnect, and MongoDB close; timeout exits for replay.
const SHUTDOWN_GRACE_MS = 15_000;

function createLifecycle({
  connect = connectDB,
  close = closeDB,
  startKafka = startConsumer,
  beginShutdown = beginConsumerShutdown,
  stopKafka = stopConsumer,
  disconnectKafka = disconnectConsumer,
  waitForMessages = waitForActiveMessages,
  processingFailed = hasShutdownProcessingFailure,
  processObject = process,
  graceMs = SHUTDOWN_GRACE_MS,
} = {}) {
  let startup;
  let shutdownPromise;
  let startupFailed = false;
  let timedOut = false;

  function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    console.log(`Consumer shutdown started: ${reason}`);
    beginShutdown();

    shutdownPromise = (async () => {
      let failed = false;
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve("timeout");
        }, graceMs);
      });

      const cleanup = (async () => {
        await startup;
        if (timedOut) return;
        console.log("Stopping Kafka consumer");
        try {
          await stopKafka();
        } catch (error) {
          failed = true;
          console.error("Failed to stop Kafka consumer:", error.message);
        }
        if (timedOut) return;

        await waitForMessages();
        if (timedOut) return;
        if (processingFailed()) {
          failed = true;
          console.error("A Kafka message failed during shutdown");
        }

        console.log("Disconnecting Kafka consumer");
        try {
          await disconnectKafka();
        } catch (error) {
          failed = true;
          console.error("Failed to disconnect Kafka consumer:", error.message);
        }
        if (timedOut) return;

        console.log("Closing consumer MongoDB connection");
        try {
          await close();
        } catch (error) {
          failed = true;
          console.error("Failed to close consumer MongoDB connection:", error.message);
        }
      })();

      try {
        const result = await Promise.race([cleanup, deadline]);
        if (result === "timeout") {
          failed = true;
          console.error("Consumer shutdown timed out; unfinished work may be replayed");
        }
      } catch (error) {
        failed = true;
        console.error("Consumer shutdown failed:", error.message);
      } finally {
        clearTimeout(timer);
      }

      const exitCode = failed || startupFailed ? 1 : 0;
      console.log(`Consumer shutdown complete with exit code ${exitCode}`);
      processObject.exit(exitCode);
    })();
    return shutdownPromise;
  }

  async function start() {
    processObject.on("SIGINT", () => { void shutdown("SIGINT"); });
    processObject.on("SIGTERM", () => { void shutdown("SIGTERM"); });

    startup = Promise.resolve().then(async () => {
      try {
        if (shutdownPromise) return;
        await connect();
        if (!shutdownPromise) await startKafka();
      } catch (error) {
        startupFailed = true;
        console.error("Failed to start consumer:", error.message);
      }
    });
    await startup;
    if (startupFailed) await shutdown("startup failure");
  }

  return { start };
}

if (require.main === module) {
  void createLifecycle().start();
}

module.exports = { createLifecycle };
