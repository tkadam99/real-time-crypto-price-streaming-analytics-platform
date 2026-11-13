const config = require("./config");

function createLivePriceTracker({
  windowMs = config.alertWindowMs,
  baselineToleranceMs = config.alertBaselineToleranceMs,
  cooldownMs = config.alertCooldownMs,
} = {}) {
  const eventsBySymbol = new Map();
  const lastAlertBySymbol = new Map();

  return {
    getBaseline(symbol, timestamp) {
      const currentTime = Date.parse(timestamp);
      if (!Number.isFinite(currentTime)) return null;

      const targetTime = currentTime - windowMs;
      const events = eventsBySymbol.get(symbol) || [];

      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.timestamp <= targetTime) {
          return targetTime - event.timestamp <= baselineToleranceMs
            ? event
            : null;
        }
      }

      return null;
    },
    recordPrice(symbol, price, timestamp, eventId) {
      const eventTime = Date.parse(timestamp);
      if (!Number.isFinite(eventTime)) return;

      const events = eventsBySymbol.get(symbol) || [];
      if (
        eventId !== undefined &&
        events.some((event) => event.eventId === eventId)
      ) {
        return;
      }

      let index = events.findIndex((event) => event.timestamp > eventTime);
      if (index === -1) index = events.length;
      events.splice(index, 0, {
        price,
        timestamp: eventTime,
        ...(eventId === undefined ? {} : { eventId }),
      });

      const newestTime = events[events.length - 1].timestamp;
      const oldestNeededTime = newestTime - windowMs - baselineToleranceMs;
      const firstNeededIndex = events.findIndex(
        (event) => event.timestamp >= oldestNeededTime
      );
      if (firstNeededIndex > 0) events.splice(0, firstNeededIndex);

      eventsBySymbol.set(symbol, events);
    },
    isOnCooldown(symbol, timestamp, eventId) {
      const eventTime = Date.parse(timestamp);
      const lastAlert = lastAlertBySymbol.get(symbol);
      return (
        lastAlert !== undefined &&
        !(eventId !== undefined && lastAlert.eventId === eventId) &&
        Number.isFinite(eventTime) &&
        eventTime - lastAlert.timestamp < cooldownMs
      );
    },
    recordAlert(symbol, timestamp, eventId) {
      const eventTime = Date.parse(timestamp);
      const lastAlert = lastAlertBySymbol.get(symbol);
      if (
        Number.isFinite(eventTime) &&
        (lastAlert === undefined || eventTime > lastAlert.timestamp)
      ) {
        lastAlertBySymbol.set(symbol, { timestamp: eventTime, eventId });
      }
    },
  };
}

function calculatePercentChange(previousPrice, currentPrice) {
  if (previousPrice === null || previousPrice === undefined) {
    return 0;
  }

  if (previousPrice === 0) {
    return 0;
  }

  return ((currentPrice - previousPrice) / previousPrice) * 100;
}


function calculateMovingAverage(prices) {
  if (!prices.length) return 0;

  const sum = prices.reduce((total, price) => total + price, 0);

  let average = sum / prices.length;

  return average;
}

function shouldCreateAlert(percentChange) {
  return Math.abs(percentChange) >= config.alertThresholdPercent;
}

function formatDuration(durationMs) {
  if (durationMs % 3_600_000 === 0) {
    const hours = durationMs / 3_600_000;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  if (durationMs % 1_000 === 0) {
    const seconds = durationMs / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  return `${durationMs} ms`;
}

function buildAlert(
  symbol,
  percentChange,
  currentPrice,
  previousPrice,
  timestamp,
  comparisonTimestamp,
  windowMs = config.alertWindowMs
) {
  const direction = percentChange > 0 ? "increased" : "decreased";

  return {
    symbol,
    alertType: "SPIKE",
    message: `${symbol} ${direction} by ${Math.abs(percentChange).toFixed(2)}% over ${formatDuration(windowMs)} (from ${previousPrice} to ${currentPrice})`,
    percentChange: Number(percentChange.toFixed(4)),
    timestamp,
    previousPrice,
    currentPrice,
    comparisonTimestamp,
    windowMs,
  };
}

module.exports = {
  createLivePriceTracker,
  calculatePercentChange,
  calculateMovingAverage,
  shouldCreateAlert,
  buildAlert,
};
