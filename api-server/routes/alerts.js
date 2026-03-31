const express = require("express");
const router = express.Router();
const { getDB } = require("../src/db");

// GET /api/alerts
router.get("/", async (req, res) => {
  try {
    const db = getDB();
    const alertsCollection = db.collection("alerts");

    const limit = Number(req.query.limit) || 20;

    const alerts = await alertsCollection
      .find({}, { projection: { _id: 0 } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    res.json({
      success: true,
      count: alerts.length,
      data: alerts,
    });
  } catch (error) {
    console.error("Error fetching alerts:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch alerts",
    });
  }
});

module.exports = router;