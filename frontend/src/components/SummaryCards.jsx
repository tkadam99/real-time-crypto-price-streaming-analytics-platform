import { marketFreshness } from "../utils/marketFreshness";
import { currentPriceCards, formatMarketTimestamp } from "../utils/currentPriceCards";

export default function SummaryCards({ prices = [], currentTime }) {
  return (
    <section className="dashboard-section">
      <h2 className="dashboard-section-title">Current Market Prices</h2>
      <div className="summary-grid">
        {currentPriceCards(prices).map((item) => {
          const freshness = marketFreshness(item.marketTimestamp, currentTime);
          return (
            <div key={item.symbol} className="summary-card">
              <span className="summary-symbol">{item.symbol}</span>
              <h3 className="summary-price">
                {item.price === null ? "Unavailable" : `$${item.price}`}
              </h3>
              <p className="summary-time">
                Market event: {formatMarketTimestamp(item.marketTimestamp)}
              </p>
              <p className={`market-freshness market-freshness--${freshness}`}>
                Market data: {freshness}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
