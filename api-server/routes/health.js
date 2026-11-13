const express = require("express");
const { getDB } = require("../src/db");
const router = express.Router();

const PING_TIMEOUT_MS = 1000;
const ERROR_LOG_INTERVAL_MS = 60_000;
let lastErrorLogAt;

router.get("/", async (req, res) => {
    try {
        const result = await getDB().command(
            { ping: 1 },
            { timeoutMS: PING_TIMEOUT_MS, signal: AbortSignal.timeout(PING_TIMEOUT_MS) }
        );
        if (result.ok !== 1) {
            throw new Error("MongoDB ping did not succeed");
        }
        res.json({
            status: "ok",
            service: "api-server",
            Timestamp: new Date().toISOString(),
        });
    } catch (error) {
        const now = Date.now();
        if (lastErrorLogAt === undefined || now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
            console.error("API health check failed:", error.message);
            lastErrorLogAt = now;
        }
        res.status(503).json({
            status: "unavailable",
            service: "api-server",
            Timestamp: new Date().toISOString(),
        });
    }
});

module.exports = router;