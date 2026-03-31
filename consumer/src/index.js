const { connectDB } = require("./mongoClient");
const { startConsumer } = require("./kafkaConsumer");

async function start() {
  try {
    await connectDB();
    await startConsumer();
  } catch (error) {
    console.error("Failed to start consumer:", error.message);
    process.exit(1);
  }
}

start();