import {
  formatTimestamp,
  formatPercentChange,
  getPercentChangeClass,
} from "../utils/formatters";

export default function SummaryCards({ latestPrices = [], metrics = [] }) {
  function getMetricForSymbol(symbol) {
    return metrics.find((item) => item.symbol === symbol);
  }

  return (
    <section className="dashboard-section">
      <h2 className="dashboard-section-title">Latest Prices</h2>

      <div className="summary-grid">
        {latestPrices.map((item) => {
          const metric = getMetricForSymbol(item.symbol);
          const percentChange = metric?.percentChange ?? 0;

          return (
            <div key={item.symbol} className="summary-card">
              <div className="summary-top-row">
                <span className="summary-symbol">{item.symbol}</span>
                <span
                  className={`summary-change ${getPercentChangeClass(percentChange)}`}
                >
                  {formatPercentChange(percentChange)}
                </span>
              </div>

              <h3 className="summary-price">${item.latestPrice}</h3>

              <p className="summary-time">
                Updated: {formatTimestamp(item.updatedAt)}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}