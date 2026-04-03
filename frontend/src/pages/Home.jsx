import Navbar from "../components/Navbar";

export default function Home() {
  return (
    <div className="home-page">
      <Navbar />

      {/* HERO */}
      <section className="hero-section">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-badge">Real-Time Streaming System</span>

            <h1 className="hero-title">
              Real-Time Crypto Price
              <br />
              Streaming Analytics Platform
            </h1>

            <p className="hero-subtitle">
              A real-time event-driven platform that ingests live cryptocurrency
              prices, processes them through Kafka, stores analytics in MongoDB,
              and exposes insights through a React dashboard.
            </p>

            <div className="hero-buttons">
              <button className="primary-btn">View Dashboard</button>
              <button className="secondary-btn">Read Documentation</button>
            </div>
          </div>

          {/* IMPROVED PREVIEW */}
          <div className="hero-right">
            <div className="preview-card">
              <div className="preview-header">Live System Preview</div>

              <div className="preview-stats">
                <div className="stat-chip">BTC ↑</div>
                <div className="stat-chip">ETH ↑</div>
                <div className="stat-chip">SOL ↓</div>
              </div>

              <div className="preview-chart" />

              <div className="preview-mini-cards">
                <div className="mini-card">
                  <span className="mini-title">Latency</span>
                  <span className="mini-value">~120ms</span>
                </div>
                <div className="mini-card">
                  <span className="mini-title">Throughput</span>
                  <span className="mini-value">Live</span>
                </div>
                <div className="mini-card">
                  <span className="mini-title">Alerts</span>
                  <span className="mini-value">Active</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* FEATURES */}
      <section className="features-section">
        <h2 className="section-title">Core Features</h2>

        <div className="features-grid">
          <div className="feature-card">
            <div className="feature-icon">📡</div>
            <h3>Live Data Ingestion</h3>
            <p>Streams live data from Coinbase WebSocket.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">⚙️</div>
            <h3>Kafka Processing</h3>
            <p>Decoupled event-driven architecture.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">📈</div>
            <h3>Analytics Engine</h3>
            <p>Moving averages, percent change & alerts.</p>
          </div>

          <div className="feature-card">
            <div className="feature-icon">🖥️</div>
            <h3>Dashboard UI</h3>
            <p>Real-time visualization of metrics.</p>
          </div>
        </div>
      </section>

      {/* ARCHITECTURE */}
      <section className="architecture-section">
        <h2 className="section-title">How the System Works</h2>

        <div className="architecture-flow">
          <div className="flow-box">Coinbase</div>
          <div className="flow-arrow">→</div>
          <div className="flow-box">Producer</div>
          <div className="flow-arrow">→</div>
          <div className="flow-box">Kafka</div>
          <div className="flow-arrow">→</div>
          <div className="flow-box">Consumer</div>
          <div className="flow-arrow">→</div>
          <div className="flow-box">MongoDB</div>
          <div className="flow-arrow">→</div>
          <div className="flow-box">API</div>
          <div className="flow-arrow">→</div>
          <div className="flow-box">React</div>
        </div>

        <p className="architecture-text">
          Event-driven architecture separating ingestion, processing, storage,
          and visualization.
        </p>
      </section>

      {/* TECH STACK */}
      <section className="tech-stack-section">
        <h2 className="section-title">Tech Stack</h2>

        <div className="tech-stack-grid">
          <span className="tech-pill">React</span>
          <span className="tech-pill">Node.js</span>
          <span className="tech-pill">Kafka</span>
          <span className="tech-pill">MongoDB</span>
          <span className="tech-pill">Docker</span>
        </div>
      </section>

      {/* CTA */}
      <section className="cta-section">
        <h2>Explore the System</h2>
        <p>View the live dashboard or read detailed documentation.</p>

        <div className="cta-buttons">
          <button className="primary-btn">Launch Dashboard</button>
          <button className="secondary-btn">View Docs</button>
        </div>
      </section>
    </div>
  );
}