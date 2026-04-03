import { formatTimestamp } from "../utils/formatters";

export default function AlertsPanel({ alerts = [] }) {
  return (
    <section className="dashboard-section dashboard-card-panel fixed-panel">
      <h2 className="dashboard-section-title">Recent Alerts</h2>

      <div className="panel-scroll-area">
        {alerts.length === 0 ? (
          <p className="empty-text">No recent alerts.</p>
        ) : (
          <div className="alerts-list">
            {alerts.map((alert, index) => (
              <div key={index} className="alert-card">
                <div className="alert-header">
                  <span className="alert-symbol">{alert.symbol}</span>
                  <span className="alert-type">{alert.alertType}</span>
                </div>
                <p className="alert-message">{alert.message}</p>
                <p className="alert-time">{formatTimestamp(alert.timestamp)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}