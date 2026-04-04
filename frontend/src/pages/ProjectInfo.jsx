import Navbar from "../components/Navbar";
import { FaReact, FaNodeJs, FaDocker } from "react-icons/fa";
import { SiApachekafka, SiMongodb } from "react-icons/si";

export default function ProjectInfo() {
  return (
    <div className="project-info-page">
      <Navbar />

      <div className="project-info-container">
        <h1 className="info-title">Project Information</h1>
        <p className="info-subtitle">
          Design decisions, challenges, and future roadmap for the real-time
          crypto analytics platform.
        </p>
        <p className="info-meta">
            Developed by Tanmay Kadam • Full Stack & Distributed Systems Project
        </p>

        {/* Summary */}
        <section className="info-section">
          <h2>Project Summary</h2>
          <p>
            This project is a real-time crypto price streaming analytics
            platform built using React, Node.js, Kafka, MongoDB, Docker, and
            Coinbase WebSocket APIs. It ingests live market data, processes it
            asynchronously, computes analytics, stores structured results, and
            visualizes insights through a web dashboard.
          </p>

           <div className="tech-badges">
                <span className="tech-badge react">
                    <FaReact className="tech-icon" />
                    React
                </span>

                <span className="tech-badge node">
                    <FaNodeJs className="tech-icon" />
                    Node.js
                </span>

                <span className="tech-badge kafka">
                    <SiApachekafka className="tech-icon" />
                    Kafka
                </span>

                <span className="tech-badge mongo">
                    <SiMongodb className="tech-icon" />
                    MongoDB
                </span>

                <span className="tech-badge docker">
                    <FaDocker className="tech-icon" />
                    Docker
                </span>
            </div>

        </section>

       

        {/* Problem Statement */}
        <section className="info-section">
          <h2>Problem Statement</h2>
          <p>
            Traditional dashboards often rely on delayed or static data. This
            project addresses the need for real-time analytics by building an
            event-driven system capable of processing live financial data,
            computing useful metrics, and surfacing alerts with minimal delay.
          </p>
        </section>

        {/* Design Decisions */}
        <section className="info-section">
          <h2>Key Design Decisions</h2>

          <div className="info-card">
            <h3>Kafka for Decoupling</h3>
            <p>
              Kafka was used to separate real-time data ingestion from
              downstream analytics and persistence, making the system more
              modular and scalable.
            </p>
            <p>
                Kafka also enables horizontal scalability by allowing multiple consumers
                to process partitions in parallel.
            </p>
          </div>

          <div className="info-card">
            <h3>MongoDB for Event Storage</h3>
            <p>
              MongoDB was chosen for flexible document storage and efficient
              handling of streaming event-style data such as price events,
              metrics snapshots, and alerts.
            </p>
          </div>

          <div className="info-card">
            <h3>Rolling Event-Based Analytics</h3>
            <p>
              Moving average and percent change were calculated using recent
              event windows rather than long historical scans, keeping analytics
              lightweight and responsive.
            </p>
          </div>

          <div className="info-card">
            <h3>Hard Cap Retention Strategy</h3>
            <p>
              To prevent unbounded database growth, the system keeps only the
              most recent fixed number of events per symbol and removes older
              entries when the threshold is exceeded.
            </p>
          </div>
        </section>

        {/* Challenges */}
        <section className="info-section">
          <h2>Challenges Faced</h2>

          <ul className="info-list">
            <li>
              Managing local MongoDB and Dockerized MongoDB without port
              conflicts.
            </li>
            <li>
              Structuring producer, consumer, API, and frontend as independent
              services while keeping configuration manageable.
            </li>
            <li>
              Handling continuously growing event data and introducing retention
              control measures.
            </li>
            <li>
              Building a frontend that balances project presentation,
              documentation, and live analytics.
            </li>
          </ul>
        </section>

        {/* Standout */}
        <section className="info-section">
          <h2>What Makes This Project Stand Out</h2>

          <div className="highlight-box">
            <p>
              This project goes beyond a typical CRUD application by combining
              real-time data ingestion, message streaming, analytics
              computation, backend APIs, and a polished frontend into one
              end-to-end system.
            </p>
          </div>

          <ul className="info-list">
            <li>Real-time event-driven architecture</li>
            <li>Producer-consumer pipeline using Kafka</li>
            <li>Analytics computation and alert generation</li>
            <li>Retention strategy for streaming data control</li>
            <li>Portfolio-ready frontend with dashboard and documentation</li>
          </ul>
        </section>

        {/* Roadmap */}
        <section className="info-section">
          <h2>Future Roadmap</h2>

          <div className="roadmap-grid">
            <div className="roadmap-card">
              <h3>Version 2</h3>
              <ul>
                <li>WebSocket push from backend to frontend</li>
                <li>Multiple coin comparison</li>
                <li>Service health monitoring</li>
                <li>Logs panel</li>
                <li>Volatility chart</li>
                <li>Daily summary</li>
              </ul>
            </div>

            <div className="roadmap-card">
              <h3>Version 3</h3>
              <ul>
                <li>Cloud deployment</li>
                <li>Full containerized stack</li>
                <li>CI/CD pipeline</li>
                <li>User authentication and authorization</li>
                <li>Alert subscriptions</li>
                <li>Email/Telegram notifications</li>
                <li>Redis caching</li>
                <li>Model-based anomaly scoring</li>
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}