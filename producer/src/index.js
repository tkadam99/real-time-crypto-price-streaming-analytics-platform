const { connectProducer } = require("./kafkaProducer");
const { startCoinbaseStream } = require("./coinbaseClient");

async function start() {
  try {
    await connectProducer();
    startCoinbaseStream();
  } catch (error) {
    console.error("Failed to start producer:", error.message);
    process.exit(1);
  }
}

start();