const WebSocket = require("ws");
const config = require("./config");
const { sendMessage } = require("./kafkaProducer");

function validateTickerMessage(message) {
  if (
    typeof message.product_id !== "string" ||
    !config.symbols.includes(message.product_id)
  ) {
    return { error: "unsupported or missing symbol" };
  }

  const rawPrice = message.price;
  if (
    (typeof rawPrice !== "number" && typeof rawPrice !== "string") ||
    (typeof rawPrice === "string" && rawPrice.trim() === "")
  ) {
    return { error: "missing or invalid price" };
  }

  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { error: "price must be a finite positive number" };
  }

  if (
    typeof message.time !== "string" ||
    message.time.trim() === "" ||
    !Number.isFinite(Date.parse(message.time))
  ) {
    return { error: "missing or invalid timestamp" };
  }

  return {
    event: {
      symbol: message.product_id,
      price,
      timestamp: message.time,
    },
  };
}

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
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      console.warn("Discarding malformed Coinbase message:", error.message);
      return;
    }

    if (!message || typeof message !== "object" || Array.isArray(message)) {
      console.warn("Discarding malformed Coinbase message: expected an object");
      return;
    }

    // We only care about ticker messages; other Coinbase message types are expected.
    if (message.type !== "ticker") return;

    try {
      const { event, error } = validateTickerMessage(message);
      if (error) {
        console.warn("Discarding invalid Coinbase ticker:", error);
        return;
      }

      const cleanedEvent = event;

      console.log("Received ticker:", cleanedEvent);

      // Send the cleaned event to Kafka topic crypto-prices using the sendMessage function from kafkaProducer.js
      try {
        await sendMessage(cleanedEvent);
        console.log("Sent to Kafka:", cleanedEvent);
      } catch (error) {
        console.error("Failed to publish ticker to Kafka:", error.message);
      }
    } catch (error) {
      console.error("Error processing Coinbase ticker:", error.message);
    }
  });

  /* Catches any errors with the WebSocket connection and logs them. If the connection is lost, 
    it will attempt to reconnect after 5 seconds. This ensures that our producer can recover from temporary network issues 
    or Coinbase WebSocket outages without crashing the application. */ 
  ws.on("error", (error) => {
    console.error("Coinbase WebSocket error:", error.message);
  });

  ws.on("close", () => {
    console.warn("Coinbase WebSocket closed. Reconnecting in 5 seconds...");
    setTimeout(startCoinbaseStream, 5000);
  });
}

module.exports = { startCoinbaseStream };