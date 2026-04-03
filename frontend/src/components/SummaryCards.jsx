export default function SummaryCards({ latestPrices }) {
  return (
    <section className="dashboard-section">
      <h2 className="dashboard-section-title">Latest Prices</h2>

      <div className="summary-grid">
        {latestPrices.map((item) => (
          <div key={item.symbol} className="summary-card">
            <span className="summary-symbol">{item.symbol}</span>
            <h3 className="summary-price">${item.latestPrice}</h3>
            <p className="summary-time">Updated: {item.updatedAt}</p>
          </div>
        ))}
      </div>
    </section>
  );
}