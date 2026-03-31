const express = require("express");
const router = express.Router();
const { getDB } = require("../src/db");

// GET /api/metrics
router.get("/", async (req, res) => {
  try {
    const db = getDB();
    const metricsCollection = db.collection("metrics");

    const metrics = await metricsCollection
      .find({}, { projection: { _id: 0 } })
      .sort({ symbol: 1 })
      .toArray();

    res.json({
      success: true,
      count: metrics.length,
      data: metrics,
    });
  } catch (error) {
    console.error("Error fetching metrics:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch metrics",
    });
  }
});

module.exports = router;