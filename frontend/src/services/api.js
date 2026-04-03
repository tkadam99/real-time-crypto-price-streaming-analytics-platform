const API_BASE_URL = "http://localhost:5000/api";

export async function fetchLatestPrices() {
  const response = await fetch(`${API_BASE_URL}/prices/latest`);
  if (!response.ok) {
    throw new Error("Failed to fetch latest prices");
  }
  return response.json();
}

export async function fetchMetrics() {
  const response = await fetch(`${API_BASE_URL}/metrics`);
  if (!response.ok) {
    throw new Error("Failed to fetch metrics");
  }
  return response.json();
}

export async function fetchAlerts(limit = 10) {
  const response = await fetch(`${API_BASE_URL}/alerts?limit=${limit}`);
  if (!response.ok) {
    throw new Error("Failed to fetch alerts");
  }
  return response.json();
}

export async function fetchPriceHistory(symbol = "BTC-USD", limit = 10) {
  const response = await fetch(
    `${API_BASE_URL}/prices/history/${symbol}?limit=${limit}`
  );
  if (!response.ok) {
    throw new Error("Failed to fetch price history");
  }
  return response.json();
}