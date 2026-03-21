const express = require("express");
const { Timestamp } = require("mongodb");
const router = express.Router();


router.get("/", async(req, res) => {
    res.json({
        status: "ok",
        service: "api-server",
        Timestamp: new Date().toISOString(),
    });
});

module.exports = router;