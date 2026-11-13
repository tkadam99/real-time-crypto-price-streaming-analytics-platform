export const DASHBOARD_SYMBOLS = ["BTC-USD", "ETH-USD", "SOL-USD"];

export function formatMarketTimestamp(timestamp) {
  if (typeof timestamp !== "string" || !timestamp.trim()) return "Unknown";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return date.toLocaleString();
}

export function currentPriceCards(prices) {
  return DASHBOARD_SYMBOLS.map((symbol) => {
    const item = prices.find((price) => price?.symbol === symbol);
    const validPrice = typeof item?.price === "number" &&
      Number.isFinite(item.price) && item.price > 0;
    return {
      symbol,
      price: validPrice ? item.price : null,
      marketTimestamp: validPrice ? item.marketTimestamp : null,
    };
  });
}
