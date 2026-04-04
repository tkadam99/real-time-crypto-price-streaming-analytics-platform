import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { formatTimestamp } from "../utils/formatters";

function buildChartData(history, windowSize = 5) {
  if (!history || history.length === 0) return [];

  // API returns newest first, but charts should usually show oldest -> newest
  const orderedHistory = [...history].reverse();

  return orderedHistory.map((item, index, arr) => {
    const start = Math.max(0, index - windowSize + 1);
    const slice = arr.slice(start, index + 1);
    const movingAverage =
      slice.reduce((sum, entry) => sum + Number(entry.price), 0) / slice.length;

    return {
      time: formatTimestamp(item.timestamp),
      price: Number(item.price),
      movingAverage: Number(movingAverage.toFixed(4)),
    };
  });
}

export default function PriceTrendChart({ history = [], selectedSymbol }) {
  const chartData = buildChartData(history, 5);

  return (
    <section className="dashboard-section chart-section">
      <h2 className="dashboard-section-title">
        Price Trend & Moving Average ({selectedSymbol})
      </h2>

      <div className="chart-card">
        {chartData.length === 0 ? (
          <p className="empty-text">No chart data available.</p>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <LineChart
              data={chartData}
              margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="time" tick={{ fontSize: 12 }} minTickGap={24} />
              <YAxis tick={{ fontSize: 12 }} domain={["auto", "auto"]} />
              <Tooltip />
              <Legend />
              <Line
                type="monotone"
                dataKey="price"
                stroke="#2563eb"
                strokeWidth={3}
                dot={false}
                name="Price"
              />
              <Line
                type="monotone"
                dataKey="movingAverage"
                stroke="#16a34a"
                strokeWidth={2}
                dot={false}
                name="Moving Avg"
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}