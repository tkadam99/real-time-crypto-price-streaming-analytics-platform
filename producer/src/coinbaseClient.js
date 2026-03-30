const WebSocket = require("ws");
const config = require("./config");
const { sendMessage } = require("./kafkaProducer");

function startCoinbaseStream() {
  const ws = new WebSocket(config.coinbaseWsUrl);


  // Establish the connection to Coinbase WebSocket and subscribe to the ticker feed for the specified symbols
  ws.on("open", () => {
    console.log("Connected to Coinbase WebSocket");

    const subscribeMessage = {
      type: "subscribe",
      product_ids: config.symbols,       // ["BTC-USD", "ETH-USD", "SOL-USD"]
      channels: ["ticker"],             //ticker channel gives you real-time price updates
    };

    ws.send(JSON.stringify(subscribeMessage));
    console.log(`Subscribed to ticker feed for: ${config.symbols.join(", ")}`);
  });

  // Receiving Live Data from Coinbase WebSocket, processing it, and sending to Kafka
  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      // We only care about ticker messages that have the necessary fields (product_id, price, time)
      // Some messages from Coinbase may be heartbeats or other types, so we filter those out
      // If any field is missing, skip it, we don't send incomplete data to Kafka
      if (message.type !== "ticker") return;
      if (!message.product_id || !message.price || !message.time) return;

      // Clean and structure the data into a consistent format before sending to Kafka
      // We convert price from string to a number and keep only the relevant fields (symbol, price, timestamp)
      const cleanedEvent = {
        symbol: message.product_id,
        price: Number(message.price),
        timestamp: message.time,
      };

      console.log("Received ticker:", cleanedEvent);

      // Send the cleaned event to Kafka topic crypto-prices using the sendMessage function from kafkaProducer.js
      await sendMessage(cleanedEvent);
      console.log("Sent to Kafka:", cleanedEvent);
    } catch (error) {
      console.error("Error processing Coinbase message:", error.message);
    }
  });

  ws.on("error", (error) => {
    console.error("Coinbase WebSocket error:", error.message);
  });

  ws.on("close", () => {
    console.warn("Coinbase WebSocket closed. Reconnecting in 5 seconds...");
    setTimeout(startCoinbaseStream, 5000);
  });
}

module.exports = { startCoinbaseStream };