const { isSupportedSymbol } = require("./validation");

function isValidMarketTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1] &&
    Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59 &&
    (zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59)) &&
    Number.isFinite(Date.parse(value));
}

function serializeCurrentPrice(document) {
  if (!document || !isSupportedSymbol(document._id) || document.symbol !== document._id ||
      typeof document.price !== "number" || !Number.isFinite(document.price) || document.price <= 0 ||
      !isValidMarketTimestamp(document.marketTimestamp) ||
      !(document.receivedAt instanceof Date) || !Number.isFinite(document.receivedAt.getTime())) {
    throw new Error("Invalid current-price snapshot");
  }
  return {
    symbol: document.symbol,
    price: document.price,
    marketTimestamp: document.marketTimestamp,
    receivedAt: document.receivedAt.toISOString(),
  };
}

module.exports = { serializeCurrentPrice };
