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
    await producer.connect();
    console.log(`Producer connected to Kafka at ${config.kafkaBroker}`);
};

// Sends one event to Kafka
const sendMessage = async (message) => {
    return producer.send({
        topic: config.kafkaTopic,
        messages: [
            {
                value: JSON.stringify(message), //Kafka expects message value to be strings or buffers so we convert object to string
            }
        ],
    });
}

module.exports = {
  connectProducer,
  disconnectProducer: () => producer.disconnect(),
  sendMessage,
};