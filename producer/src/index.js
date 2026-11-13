const { connectProducer, disconnectProducer } = require("./kafkaProducer");
const {
  startCoinbaseStream,
  beginCoinbaseShutdown,
  stopCoinbaseStream,
  terminateCoinbaseStream,
  drainPublishes,
  hasShutdownPublishFailure,
} = require("./coinbaseClient");

// Total shutdown budget, including startup, WebSocket close, publishes and Kafka disconnect.
const SHUTDOWN_GRACE_MS = 15_000;

function createLifecycle({
  connect = connectProducer,
  disconnect = disconnectProducer,
  startStream = startCoinbaseStream,
  beginShutdown = beginCoinbaseShutdown,
  stopStream = stopCoinbaseStream,
  terminateStream = terminateCoinbaseStream,
  drain = drainPublishes,
  publishFailed = hasShutdownPublishFailure,
  processObject = process,
  graceMs = SHUTDOWN_GRACE_MS,
} = {}) {
  let startup;
  let shutdownPromise;
  let startupFailed = false;
  let timedOut = false;

  function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    console.log(`Producer shutdown started: ${reason}`);
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
        const closed = Promise.resolve().then(() => stopStream()).catch((error) => {
          failed = true;
          console.error("Failed to close Coinbase WebSocket:", error.message);
          try {
            terminateStream();
          } catch (terminateError) {
            console.error("Failed to terminate Coinbase WebSocket:", terminateError.message);
          }
        });
        await startup;
        if (timedOut) return;
        await closed;
        if (timedOut) return;
        console.log("Draining Kafka publishes");
        await drain();
        if (timedOut) return;
        if (publishFailed()) {
          failed = true;
          console.error("A Kafka publish failed during shutdown");
        }
        console.log("Disconnecting Kafka producer");
        try {
          await disconnect();
        } catch (error) {
          failed = true;
          console.error("Failed to disconnect Kafka producer:", error.message);
        }
      })();

      try {
        const result = await Promise.race([cleanup, deadline]);
        if (result === "timeout") {
          failed = true;
          console.error("Producer shutdown timed out; outstanding publishes may be lost");
          try {
            terminateStream();
          } catch (error) {
            console.error("Failed to terminate Coinbase WebSocket:", error.message);
          }
        }
      } catch (error) {
        failed = true;
        console.error("Producer shutdown failed:", error.message);
        try {
          terminateStream();
        } catch (terminateError) {
          console.error("Failed to terminate Coinbase WebSocket:", terminateError.message);
        }
      } finally {
        clearTimeout(timer);
      }

      const exitCode = failed || startupFailed ? 1 : 0;
      console.log(`Producer shutdown complete with exit code ${exitCode}`);
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
        if (!shutdownPromise) startStream();
      } catch (error) {
        startupFailed = true;
        console.error("Failed to start producer:", error.message);
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
