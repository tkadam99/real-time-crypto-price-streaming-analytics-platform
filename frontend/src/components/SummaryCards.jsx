import {
  formatTimestamp,
  formatPercentChange,
  getPercentChangeClass,
} from "../utils/formatters";

export default function SummaryCards({ metrics = [] }) {
  return (
    <section className="dashboard-section">
      <h2 className="dashboard-section-title">Latest Prices</h2>

      <div className="summary-grid">
        {metrics.map((item) => (
          <div key={item.symbol} className="summary-card">
            <div className="summary-top-row">
              <span className="summary-symbol">{item.symbol}</span>
              <span
                className={`summary-change ${getPercentChangeClass(item.percentChange)}`}
              >
                {formatPercentChange(item.percentChange)}
              </span>
            </div>

            <h3 className="summary-price">${item.latestPrice}</h3>

            <p className="summary-time">
              Updated: {formatTimestamp(item.updatedAt)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}