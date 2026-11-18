const { transformV1Record } = require("./relayTransform");

const V1_TOPIC = "crypto-prices";
const V2_TOPIC = "crypto-prices-v2";
const RELAY_CONSUMER_GROUP_ID = "crypto-v2-relay-group";

function createRelayRunner({
  consumer,
  producer,
  sourceIdentity,
  v2PartitionCount,
}) {
  if (!consumer || typeof consumer.subscribe !== "function" ||
      typeof consumer.run !== "function" ||
      typeof consumer.commitOffsets !== "function" ||
      typeof consumer.stop !== "function") {
    throw new Error("Invalid Kafka consumer.");
  }
  if (!producer || typeof producer.send !== "function") {
    throw new Error("Invalid Kafka producer.");
  }
  if (!sourceIdentity || typeof sourceIdentity.clusterId !== "string" ||
      !sourceIdentity.clusterId.trim() ||
      typeof sourceIdentity.topicGenerationId !== "string" ||
      !sourceIdentity.topicGenerationId.trim()) {
    throw new Error("Invalid relay source identity configuration.");
  }
  const { clusterId, topicGenerationId } = sourceIdentity;

  let startPromise;
  let stopPromise;
  let runStarted = false;
  let stopRequested = false;
  const inFlight = new Set();

  async function processMessage({ topic, partition, message }) {
    const record = {
      topic,
      partition,
      offset: message.offset,
      value: message.value,
    };
    const output = transformV1Record(
      record,
      clusterId,
      topicGenerationId,
      v2PartitionCount,
    );
    await producer.send({ topic: V2_TOPIC, messages: [output] });
    await consumer.commitOffsets([{
      topic,
      partition,
      offset: (BigInt(record.offset) + 1n).toString(),
    }]);
  }

  async function eachMessage(payload) {
    const processing = processMessage(payload);
    let tracked;
    tracked = processing.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    await tracked;
  }

  function start() {
    if (stopRequested) return Promise.reject(new Error("Relay is stopping."));
    if (startPromise) return startPromise;

    startPromise = (async () => {
      await consumer.subscribe({ topic: V1_TOPIC, fromBeginning: false });
      if (stopRequested) return;
      runStarted = true;
      await consumer.run({
        autoCommit: false,
        partitionsConsumedConcurrently: 1,
        eachMessage,
      });
    })();
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopRequested = true;
    stopPromise = (async () => {
      let startError;
      if (startPromise) {
        try {
          await startPromise;
        } catch (error) {
          startError = error;
        }
      }

      let stopError;
      if (runStarted) {
        try {
          await consumer.stop();
        } catch (error) {
          stopError = error;
        }
      }

      let handlerError;
      while (inFlight.size > 0) {
        try {
          await Promise.all([...inFlight]);
        } catch (error) {
          handlerError = error;
        }
      }

      if (startError) throw startError;
      if (stopError) throw stopError;
      if (handlerError) throw handlerError;
    })();
    return stopPromise;
  }

  return { start, stop };
}

module.exports = {
  V1_TOPIC,
  V2_TOPIC,
  RELAY_CONSUMER_GROUP_ID,
  createRelayRunner,
};
