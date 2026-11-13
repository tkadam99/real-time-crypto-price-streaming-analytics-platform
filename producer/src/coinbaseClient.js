const WebSocket = require("ws");
const config = require("./config");
const { sendMessage } = require("./kafkaProducer");

let shuttingDown = false;
let socket;
let reconnectTimer;
const pendingPublishes = new Set();
let failedDuringShutdown = false;

function beginCoinbaseShutdown() {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
}

function stopCoinbaseStream() {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  const ws = socket;
  return new Promise((resolve, reject) => {
    const connecting = ws.readyState === WebSocket.CONNECTING;
    const onClose = () => {
      ws.removeListener("error", onError);
      resolve();
    };
    const onError = (error) => {
      if (connecting &&
          error.message === "WebSocket was closed before the connection was established") {
        return;
      }
      ws.removeListener("close", onClose);
      reject(error);
    };
    ws.once("close", onClose);
    ws.once("error", onError);
    try {
      ws.close();
    } catch (error) {
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
      reject(error);
    }
  });
}

function terminateCoinbaseStream() {
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

async function drainPublishes() {
  await Promise.all(pendingPublishes);
}

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
  if (shuttingDown) return;
  const ws = new WebSocket(config.coinbaseWsUrl);
  socket = ws;


  // Establish the connection to Coinbase WebSocket and subscribe to the ticker feed for the specified symbols
  ws.on("open", () => {
    if (shuttingDown) return;
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
    if (shuttingDown) return;
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
      const publish = (async () => {
        try {
          await sendMessage(cleanedEvent);
          if (!shuttingDown) console.log("Sent to Kafka:", cleanedEvent);
        } catch (error) {
          if (shuttingDown) failedDuringShutdown = true;
          console.error("Failed to publish ticker to Kafka:", error.message);
        }
      })();
      pendingPublishes.add(publish);
      try {
        await publish;
      } finally {
        pendingPublishes.delete(publish);
      }
    } catch (error) {
      console.error("Error processing Coinbase ticker:", error.message);
    }
  });

  /* Catches any errors with the WebSocket connection and logs them. If the connection is lost, 
    it will attempt to reconnect after 5 seconds. This ensures that our producer can recover from temporary network issues 
    or Coinbase WebSocket outages without crashing the application. */ 
  ws.on("error", (error) => {
    if (shuttingDown && error.message === "WebSocket was closed before the connection was established") {
      return;
    }
    if (shuttingDown) {
      console.error("Coinbase WebSocket error during shutdown:", error.message);
      return;
    }
    console.error("Coinbase WebSocket error:", error.message);
  });

  ws.on("close", () => {
    if (socket === ws) socket = undefined;
    if (shuttingDown) return;
    console.warn("Coinbase WebSocket closed. Reconnecting in 5 seconds...");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!shuttingDown) startCoinbaseStream();
    }, 5000);
  });
}

module.exports = {
  startCoinbaseStream,
  beginCoinbaseShutdown,
  stopCoinbaseStream,
  terminateCoinbaseStream,
  drainPublishes,
  hasShutdownPublishFailure: () => failedDuringShutdown,
};