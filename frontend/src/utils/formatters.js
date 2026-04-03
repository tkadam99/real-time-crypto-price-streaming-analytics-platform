export function formatTimestamp(timestamp) {
  if (!timestamp) return "-";

  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) return timestamp;

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatPercentChange(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }

  return `${Number(value).toFixed(4)}%`;
}

export function getPercentChangeClass(value) {
  const numericValue = Number(value);

  if (Number.isNaN(numericValue)) return "neutral-change";
  if (numericValue > 0) return "positive-change";
  if (numericValue < 0) return "negative-change";
  return "neutral-change";
}