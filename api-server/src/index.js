const express = require("express");
const app = express();

const cors = require("cors");
const { connectDB } = require("./db");
const config = require("./config");
const healthRoute = require("../routes/health");

//Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

//Mount the health router at /api/health
app.use("/api/health", healthRoute);

const startServer = async () => {
    try {
        await connectDB();

        app.listen(config.port, () => {
            console.log(`API server running on http://localhost:${config.port}`);
        })
    } catch (error) {
        console.error("Failed to load API Server", error.message);
        process.exit(1);
    }
}

startServer();