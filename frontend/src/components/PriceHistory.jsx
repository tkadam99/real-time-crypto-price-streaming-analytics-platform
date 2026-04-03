import { formatTimestamp } from "../utils/formatters";

export default function PriceHistory({ history = [], selectedSymbol }) {
  return (
    <section className="dashboard-section dashboard-card-panel fixed-panel">
      <h2 className="dashboard-section-title">
        Recent Price History ({selectedSymbol})
      </h2>

      <div className="panel-scroll-area">
        {history.length === 0 ? (
          <p className="empty-text">No recent history available.</p>
        ) : (
          <div className="history-list">
            {history.map((item, index) => (
              <div key={index} className="history-row">
                <span className="history-price">${item.price}</span>
                <span className="history-time">
                  {formatTimestamp(item.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}