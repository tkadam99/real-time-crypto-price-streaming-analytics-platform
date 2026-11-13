const SUPPORTED_SYMBOLS = new Set(["BTC-USD", "ETH-USD", "SOL-USD"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 10000;

function isSupportedSymbol(symbol) {
  return typeof symbol === "string" && SUPPORTED_SYMBOLS.has(symbol);
}

function parseLimit(query) {
  if (Object.keys(query).some((key) => key.startsWith("limit["))) return null;
  const value = query.limit;
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;

  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LIMIT
    ? limit
    : null;
}

module.exports = { isSupportedSymbol, parseLimit, MAX_LIMIT };
