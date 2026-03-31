const express = require("express");
const router = express.Router();
const { getDB } = require("../src/db");

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
  try {
    const db = getDB();
    const priceEventsCollection = db.collection("price_events");

    const { symbol } = req.params;
    const limit = Number(req.query.limit) || 20;

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