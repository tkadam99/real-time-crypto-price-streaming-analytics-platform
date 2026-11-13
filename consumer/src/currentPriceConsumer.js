const { parseEvent, createCurrentPriceProjection } = require("./currentPriceProjection");

const CURRENT_PRICE_GROUP = "crypto-current-price-group";

function createCurrentPriceService({
  consumer, mongoClient, dbName, topic, symbols, processObject = process,
  logger = console, now = Date.now, graceMs = 15000,
}) {
  let startup;
  let shutdownPromise;
  let stopping = false;
  let startupFailed = false;
  let processingFailedDuringShutdown = false;
  let removeCrashListener;

  async function processRecord(record, projection) {
    if (stopping) throw new Error("Current-price consumer is shutting down");
    try {
      const result = parseEvent(record, symbols, now());
      if (result.error) {
        logger.warn("Skipping invalid current-price event:", result.error, {
          topic: record.topic, partition: record.partition, offset: record.message.offset,
        });
        return;
      }
      await projection.save(result.snapshot);
    } catch (error) {
      if (stopping) processingFailedDuringShutdown = true;
      logger.error("Current-price processing failed:", error.message);
      throw error;
    }
  }

  function shutdown(reason, failed = false) {
    if (failed) startupFailed = true;
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    logger.log(`Current-price shutdown started: ${reason}`);
    shutdownPromise = (async () => {
      let cleanupFailed = false;
      let timedOut = false;
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve("timeout"); }, graceMs);
      });
      const cleanup = (async () => {
        await startup;
        if (timedOut) return;
        for (const [label, operation] of [
          ["stop Kafka", () => consumer.stop()],
          ["disconnect Kafka", () => consumer.disconnect()],
          ["close MongoDB", () => mongoClient.close()],
        ]) {
          if (timedOut) return;
          try { await operation(); } catch (error) {
            cleanupFailed = true;
            logger.error(`Current-price ${label} failed:`, error.message);
          }
        }
      })();
      try {
        if (await Promise.race([cleanup, deadline]) === "timeout") {
          cleanupFailed = true;
          logger.error("Current-price shutdown timed out; unfinished work may replay");
        }
      } catch (error) {
        cleanupFailed = true;
        logger.error("Current-price shutdown failed:", error.message);
      } finally {
        clearTimeout(timer);
        if (removeCrashListener) removeCrashListener();
      }
      const code = cleanupFailed || startupFailed || processingFailedDuringShutdown ? 1 : 0;
      logger.log(`Current-price shutdown complete with exit code ${code}`);
      processObject.exit(code);
    })();
    return shutdownPromise;
  }

  async function start() {
    processObject.on("SIGINT", () => { void shutdown("SIGINT"); });
    processObject.on("SIGTERM", () => { void shutdown("SIGTERM"); });
    removeCrashListener = consumer.on(consumer.events.CRASH, ({ payload }) => {
      logger.error("Current-price Kafka consumer crashed:", payload.error.message);
      if (!payload.restart) void shutdown("Kafka consumer stopped", true);
    });
    startup = Promise.resolve().then(async () => {
      try {
        await mongoClient.connect();
        if (stopping) return;
        const collection = mongoClient.db(dbName).collection("current_prices");
        const projection = createCurrentPriceProjection(collection);
        await consumer.connect();
        if (stopping) return;
        await consumer.subscribe({ topic, fromBeginning: false });
        if (stopping) return;
        await consumer.run({ eachMessage: (record) => processRecord(record, projection) });
        if (!stopping) logger.log("Current-price consumer started; missing group offsets start at the topic tail.");
      } catch (error) {
        startupFailed = true;
        logger.error("Current-price startup failed:", error.message);
      }
    });
    await startup;
    if (startupFailed) await shutdown("startup failure", true);
  }

  return { start, shutdown, processRecord };
}

module.exports = { CURRENT_PRICE_GROUP, createCurrentPriceService };
