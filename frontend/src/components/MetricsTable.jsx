export default function MetricsTable({ metrics }) {
  return (
    <section className="dashboard-section">
      <h2 className="dashboard-section-title">Metrics Snapshot</h2>

      <div className="table-wrapper">
        <table className="metrics-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Latest Price</th>
              <th>Previous Price</th>
              <th>Moving Average</th>
              <th>Percent Change</th>
              <th>Updated At</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((item) => (
              <tr key={item.symbol}>
                <td>{item.symbol}</td>
                <td>{item.latestPrice}</td>
                <td>{item.previousPrice ?? "-"}</td>
                <td>{item.movingAverage}</td>
                <td>{item.percentChange}%</td>
                <td>{item.updatedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}