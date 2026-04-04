import Navbar from "../components/Navbar";

export default function Documentation() {
  return (
    <div className="documentation-page">
      <Navbar />

      <div className="documentation-container">
        <h1 className="doc-title">System Documentation</h1>
        <p className="doc-subtitle">
          Detailed breakdown of architecture, data flow, and system components.
        </p>

        {/* Overview */}
        <section className="doc-section">
          <h2>Overview</h2>
          <p className="doc-highlight">
            Designed as an event-driven microservices-style pipeline to ensure scalability, fault tolerance, and real-time processing.
          </p>
          <p>
            This system is a real-time crypto analytics platform that ingests
            live price data, processes it through Kafka, computes analytics, and
            exposes insights through a REST API and React dashboard.
          </p>
        </section>

        {/* Architecture */}
        <section className="doc-section">
          <h2>System Architecture</h2>
          <div className="doc-architecture">
            {["Coinbase", "Producer", "Kafka", "Consumer", "MongoDB", "API", "React"].map((item, index) => (
              <div key={index} className="arch-step">
                <span>{item}</span>
                {index !== 6 && <span className="arrow">→</span>}
             </div>
            ))}
          </div>
        </section>

        {/* Data Flow */}
        <section className="doc-section">
          <h2>Data Flow</h2>
          <ol>
            <li>Producer connects to Coinbase WebSocket</li>
            <li>Streams real-time crypto price events</li>
            <li>Publishes events to Kafka topic</li>
            <li>Consumer reads events from Kafka</li>
            <li>Processes and computes analytics</li>
            <li>Stores results in MongoDB</li>
            <li>API exposes data to frontend</li>
          </ol>
        </section>

        {/* Components */}
        <section className="doc-section">
          <h2>System Components</h2>

          <div className="doc-card">
            <h3>Producer</h3>
            <p>
              Connects to Coinbase WebSocket and streams live crypto price data
              into Kafka.
            </p>
          </div>

          <div className="doc-card">
            <h3>Kafka</h3>
            <p>
              Acts as a message broker to decouple data ingestion from
              processing.
            </p>
            <p>
              Kafka enables high-throughput, fault-tolerant streaming and decouples producers from consumers.
            </p>
          </div>

          <div className="doc-card">
            <h3>Consumer</h3>
            <p>
              Processes events, calculates moving averages and percent change,
              and generates alerts.
            </p>
          </div>

          <div className="doc-card">
            <h3>MongoDB</h3>
            <p>
              MongoDB is used for flexible schema design and fast writes for streaming data.
            </p>
            <p>
              Stores raw events, computed metrics, and alerts for querying.
            </p>
          </div>

          <div className="doc-card">
            <h3>API Server</h3>
            <p>
              Provides REST endpoints for frontend data consumption.
            </p>
          </div>

          <div className="doc-card">
            <h3>Frontend</h3>
            <p>
              React dashboard visualizes real-time analytics and system data.
            </p>
          </div>
        </section>

        {/* Database */}
        <section className="doc-section">
          <h2>Database Design</h2>

          <ul>
            <li>
              <strong>price_events</strong> → stores raw incoming events
            </li>
            <li>
              <strong>metrics</strong> → latest computed snapshot per symbol
            </li>
            <li>
              <strong>alerts</strong> → stores spike alerts
            </li>
          </ul>
        </section>

        {/* APIs */}
        <section className="doc-section">
          <h2>API Endpoints</h2>

          <ul>
            {/* <li>GET /api/prices/latest</li> */}
            <div className="api-row">
              <span className="api-method">GET</span>
              <span className="api-path">/api/prices/latest</span>
            </div>
            {/* <li>GET /api/prices/history/:symbol</li> */}
            <div className="api-row">
              <span className="api-method">GET</span>
              <span className="api-path">/api/prices/history/:symbol</span>
            </div>
            {/* <li>GET /api/metrics</li> */}
            <div className="api-row">
              <span className="api-method">GET</span>
              <span className="api-path">/api/metrics</span>
            </div>
            {/* <li>GET /api/alerts</li> */}
            <div className="api-row">
              <span className="api-method">GET</span>
              <span className="api-path">/api/alerts</span>
            </div>
            {/* <li>GET /api/health</li> */}
            <div className="api-row">
              <span className="api-method">GET</span>
              <span className="api-path">/api/health</span>
            </div>
          </ul>
        </section>

        {/* Processing */}
        <section className="doc-section">
          <h2>Data Processing Logic</h2>

          <ul>
            <li>Moving average calculation</li>
            <li>Percent change computation</li>
            <li>Alert generation based on threshold</li>
          </ul>
        </section>

        {/* Control Measures */}
        <section className="doc-section">
          <h2>Control Measures</h2>

          <ul>
            <li>Limit number of events per symbol</li>
            <li>Delete oldest records beyond threshold</li>
            <li>Prevent unbounded database growth</li>
            <li>Ensures memory and storage efficiency in high-throughput systems</li>
          </ul>
        </section>
      </div>
    </div>
  );
}