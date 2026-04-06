const express = require("express");
const cors = require("cors");

const healthRoute = require("../routes/health");
const pricesRoute = require("../routes/prices");
const metricsRoute = require("../routes/metrics");
const alertsRoute = require("../routes/alerts");

const app = express();

//Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use("/api/health", healthRoute);
app.use("/api/prices", pricesRoute);
app.use("/api/metrics", metricsRoute);
app.use("/api/alerts", alertsRoute);

module.exports = app;