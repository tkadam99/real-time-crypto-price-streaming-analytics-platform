require("dotenv").config();

function readNumericSetting(name, defaultValue, isValid, constraint) {
  const rawValue = process.env[name];
  if (rawValue === undefined) return defaultValue;

  const value = Number(rawValue);
  if (rawValue.trim() === "" || !Number.isFinite(value) || !isValid(value)) {
    throw new Error(
      `${name} must be ${constraint}; received ${JSON.stringify(rawValue)}.`
    );
  }

  return value;
}

function readBooleanSetting(name) {
  const value = process.env[name];
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be "true" or "false"; received ${JSON.stringify(value)}.`);
}

module.exports = {
  kafkaBroker: process.env.KAFKA_BROKER || "localhost:9092",
  kafkaTopic: process.env.KAFKA_TOPIC || "crypto-prices",
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  dbName: process.env.DB_NAME || "crypto_analytics",
  symbols: ["BTC-USD", "ETH-USD", "SOL-USD"],
  processingTimings: readBooleanSetting("CONSUMER_PROCESSING_TIMINGS"),
  decisionCleanupEnabled: readBooleanSetting("ALERT_DECISION_CLEANUP_ENABLED"),
  alertThresholdPercent: readNumericSetting(
    "ALERT_THRESHOLD_PERCENT",
    0.5,
    (value) => value > 0,
    "a finite number greater than 0"
  ),
  alertWindowMs: readNumericSetting(
    "ALERT_WINDOW_MS",
    60_000,
    (value) => value > 0,
    "a finite number greater than 0"
  ),
  alertBaselineToleranceMs: readNumericSetting(
    "ALERT_BASELINE_TOLERANCE_MS",
    10_000,
    (value) => value >= 0,
    "a finite number greater than or equal to 0"
  ),
  alertCooldownMs: readNumericSetting(
    "ALERT_COOLDOWN_MS",
    300_000,
    (value) => value >= 0,
    "a finite number greater than or equal to 0"
  ),
  movingAverageWindow: readNumericSetting(
    "MOVING_AVERAGE_WINDOW",
    5,
    (value) => Number.isSafeInteger(value) && value > 0,
    "a positive safe integer"
  ),
  maxEventsPerSymbol: readNumericSetting(
    "MAX_EVENTS_PER_SYMBOL",
    10_000,
    (value) => Number.isSafeInteger(value) && value > 0,
    "a positive safe integer"
  ),
};
