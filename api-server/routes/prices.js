const express = require("express");
const router = express.Router();
const { getDB } = require("../src/db");
const { isSupportedSymbol, parseLimit, MAX_LIMIT } = require("../src/validation");

// GET /api/prices/latest
router.get("/latest", async (req, res) => {
  try {
    const db = getDB();
    const metricsCollection = db.collection("metrics");

    const latestPrices = await metricsCollection
      .find({}, { projection: { _id: 0, symbol: 1, latestPrice: 1, updatedAt: 1 } })
      .sort({ symbol: 1 })
      .toArray();

    res.json({
      success: true,
      count: latestPrices.length,
      data: latestPrices,
    });
  } catch (error) {
    console.error("Error fetching latest prices:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch latest prices",
    });
  }
});

// GET /api/prices/history/:symbol
router.get("/history/:symbol", async (req, res) => {
  const { symbol } = req.params;
  if (!isSupportedSymbol(symbol)) {
    return res.status(400).json({
      success: false,
      message: "Unsupported symbol; expected BTC-USD, ETH-USD, or SOL-USD",
    });
  }
  const limit = parseLimit(req.query);
  if (limit === null) {
    return res.status(400).json({
      success: false,
      message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
    });
  }

  try {
    const db = getDB();
    const priceEventsCollection = db.collection("price_events");

    const history = await priceEventsCollection
      .find({ symbol })
      .sort({ timestamp: -1 })
      .limit(limit)
      .project({ _id: 0, symbol: 1, price: 1, timestamp: 1, receivedAt: 1 })
      .toArray();

    res.json({
      success: true,
      symbol,
      count: history.length,
      data: history,
    });
  } catch (error) {
    console.error("Error fetching price history:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch price history",
    });
  }
});

module.exports = router;