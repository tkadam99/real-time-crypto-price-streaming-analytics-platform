import { useEffect, useRef, useState } from "react";
import Navbar from "../components/Navbar";
import SummaryCards from "../components/SummaryCards";
import MetricsTable from "../components/MetricsTable";
import AlertsPanel from "../components/AlertsPanel";
import PriceHistory from "../components/PriceHistory";
import PriceTrendChart from "../components/PriceTrendChart";
import { fetchCurrentPrices, fetchMetrics, fetchAlerts, fetchPriceHistory } from "../services/api";
import { createDashboardRefresh } from "../services/dashboardRefresh";

const INITIAL_SYMBOL = "BTC-USD";

export default function Dashboard() {
  const [selectedSymbol, setSelectedSymbol] = useState(INITIAL_SYMBOL);
  const [dashboard, setDashboard] = useState({
    currentPrices: [],
    metrics: [],
    alerts: [],
    history: [],
    historySymbol: null,
    hasCurrentPrices: false,
    hasHistory: false,
    refreshing: true,
    currentError: "",
    historyError: "",
    lastCurrentRefresh: null,
    lastHistoricalRefresh: null,
    currentTime: null,
  });
  const refreshController = useRef(null);

  useEffect(() => {
    const controller = createDashboardRefresh({
      fetchCurrentPrices,
      fetchMetrics,
      fetchAlerts,
      fetchPriceHistory,
      onChange: setDashboard,
      initialSymbol: INITIAL_SYMBOL,
    });
    refreshController.current = controller;
    controller.start();
    return () => {
      controller.stop();
      refreshController.current = null;
    };
  }, []);

  function changeSymbol(event) {
    const symbol = event.target.value;
    setSelectedSymbol(symbol);
    refreshController.current?.setSymbol(symbol);
  }

  const history = dashboard.historySymbol === selectedSymbol ? dashboard.history : [];

  return (
    <div className="dashboard-page">
      <Navbar />

      <div className="dashboard-container">
        <div className="dashboard-header">
          <div>
            <h1 className="dashboard-title">Live Analytics Dashboard</h1>
            <p className="dashboard-subtitle">
              Current prices and historical analytics from the streaming pipeline.
              Historical analytics, charts, and alerts may be behind while Kafka catches up.
            </p>
            <p className="dashboard-refresh-time">
              Last successful current-price refresh:{" "}
              {dashboard.lastCurrentRefresh === null
                ? "Not yet"
                : new Date(dashboard.lastCurrentRefresh).toLocaleString()}
              {" | "}Historical analytics refresh:{" "}
              {dashboard.lastHistoricalRefresh === null
                ? "Not yet"
                : new Date(dashboard.lastHistoricalRefresh).toLocaleString()}
            </p>
          </div>

          <div className="dashboard-controls">
            <select
              className="symbol-select"
              value={selectedSymbol}
              onChange={changeSymbol}
              aria-label="Select symbol"
            >
              <option value="BTC-USD">BTC-USD</option>
              <option value="ETH-USD">ETH-USD</option>
              <option value="SOL-USD">SOL-USD</option>
            </select>

            <button
              className="primary-btn"
              onClick={() => refreshController.current?.refresh()}
            >
              {dashboard.refreshing ? "Refresh Again" : "Refresh Data"}
            </button>
          </div>
        </div>

        {!dashboard.hasCurrentPrices && !dashboard.hasHistory && dashboard.refreshing && (
          <p className="status-text">Loading dashboard data...</p>
        )}
        {dashboard.currentError && (
          <p className="error-text" role="alert">
            Current prices: {dashboard.currentError}
            {dashboard.hasCurrentPrices ? " Showing the last successful prices." : ""}
          </p>
        )}
        {dashboard.historyError && (
          <p className="error-text" role="alert">
            Historical analytics: {dashboard.historyError}
            {dashboard.hasHistory ? " Showing the last successful analytics." : ""}
          </p>
        )}

        <SummaryCards prices={dashboard.currentPrices} currentTime={dashboard.currentTime} />
        {dashboard.hasHistory && (
          <>
            <MetricsTable metrics={dashboard.metrics} />
            <PriceTrendChart history={history} selectedSymbol={selectedSymbol} />
            <div className="dashboard-lower-grid">
              <AlertsPanel alerts={dashboard.alerts} />
              <PriceHistory history={history} selectedSymbol={selectedSymbol} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
