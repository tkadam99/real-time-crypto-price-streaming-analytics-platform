const { Kafka } = require("kafkajs");
const config = require("./config");

// Creating a Kafka client
const kafka = new Kafka({
  clientId: "crypto-price-producer",    // Logical Identifier for app in kafka
  brokers: [config.kafkaBroker],   // Kafka broker address (localhost:9092) this app connects to
});

const producer = kafka.producer();

// Producer establish connection to Kafka
const connectProducer = async () => {
    try {
        await producer.connect();
        console.log(`Producer connected to Kafka at ${config.kafkaBroker}`);
    }
    catch (err) {
        console.error("Failed to connect producer to Kafka:", err.message);
        process.exit(1);
    }
    
};

// Sends one event to Kafka
const sendMessage = async (message) => {
    try {
        await producer.send({
            topic: config.kafkaTopic,
            messages: [
                {
                    value: JSON.stringify(message), //Kafka expects message value to be strings or buffers so we convert object to string
                }
            ],
        });
    }
    catch (err) {
        console.error("Failed to send message to Kafka:", err.message);
    }
}

module.exports = {
  connectProducer,
  sendMessage,
};