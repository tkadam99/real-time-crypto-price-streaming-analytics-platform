import { useEffect, useState, useCallback } from "react";
import Navbar from "../components/Navbar";
import SummaryCards from "../components/SummaryCards";
import MetricsTable from "../components/MetricsTable";
import AlertsPanel from "../components/AlertsPanel";
import PriceHistory from "../components/PriceHistory";
import PriceTrendChart from "../components/PriceTrendChart";
import {
  fetchLatestPrices,
  fetchMetrics,
  fetchAlerts,
  fetchPriceHistory,
} from "../services/api";

export default function Dashboard() {
  const [latestPrices, setLatestPrices] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [history, setHistory] = useState([]);
  const [selectedSymbol, setSelectedSymbol] = useState("BTC-USD");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadDashboardData = useCallback(async (symbol = selectedSymbol) => {
  try {
    setLoading(true);
    setError("");

    const [latestRes, metricsRes, alertsRes, historyRes] = await Promise.all([
      fetchLatestPrices(),
      fetchMetrics(),
      fetchAlerts(10),
      fetchPriceHistory(symbol, 10),
    ]);

    setLatestPrices(latestRes.data || []);
    setMetrics(metricsRes.data || []);
    setAlerts(alertsRes.data || []);
    setHistory(historyRes.data || []);
  } catch (err) {
    setError(err.message || "Something went wrong");
  } finally {
    setLoading(false);
  }
}, [selectedSymbol]);

  useEffect(() => {
    loadDashboardData(selectedSymbol);
  }, [selectedSymbol, loadDashboardData]);

  return (
    <div className="dashboard-page">
      <Navbar />

      <div className="dashboard-container">
        <div className="dashboard-header">
          <div>
            <h1 className="dashboard-title">Live Analytics Dashboard</h1>
            <p className="dashboard-subtitle">
              View real-time metrics, alerts, and historical price events from
              the streaming pipeline.
            </p>
          </div>

          <div className="dashboard-controls">
            <select
              className="symbol-select"
              value={selectedSymbol}
              onChange={(e) => setSelectedSymbol(e.target.value)}
            >
              <option value="BTC-USD">BTC-USD</option>
              <option value="ETH-USD">ETH-USD</option>
              <option value="SOL-USD">SOL-USD</option>
            </select>

            <button
              className="primary-btn"
              onClick={() => loadDashboardData(selectedSymbol)}
            >
              Refresh Data
            </button>
          </div>
        </div>

        {loading && <p className="status-text">Loading dashboard data...</p>}
        {error && <p className="error-text">{error}</p>}

        {!loading && !error && (
          <>
            {/* <SummaryCards latestPrices={latestPrices} /> */}
            <SummaryCards latestPrices={latestPrices} metrics={metrics} />
            <MetricsTable metrics={metrics} />
            <PriceTrendChart history={history} selectedSymbol={selectedSymbol} />
            <div className="dashboard-lower-grid">
              <AlertsPanel alerts={alerts} />
              <PriceHistory history={history} selectedSymbol={selectedSymbol} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}