const config = require("./config");

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



function buildAlert(symbol, percentChange, currentPrice, previousPrice, timestamp) {
  const direction = percentChange > 0 ? "increased" : "decreased";

  return {
    symbol,
    alertType: "SPIKE",
    message: `${symbol} ${direction} by ${Math.abs(percentChange).toFixed(2)}% (from ${previousPrice} to ${currentPrice})`,
    percentChange: Number(percentChange.toFixed(4)),
    timestamp,
  };
}

module.exports = {
  calculatePercentChange,
  calculateMovingAverage,
  shouldCreateAlert,
  buildAlert,
};
