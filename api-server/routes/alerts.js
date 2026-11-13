const express = require("express");
const router = express.Router();
const { getDB } = require("../src/db");
const { parseLimit, MAX_LIMIT } = require("../src/validation");

// GET /api/alerts
router.get("/", async (req, res) => {
  const limit = parseLimit(req.query);
  if (limit === null) {
    return res.status(400).json({
      success: false,
      message: `limit must be an integer between 1 and ${MAX_LIMIT}`,
    });
  }

  try {
    const db = getDB();
    const alertsCollection = db.collection("alerts");

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