import { Link, useLocation } from "react-router-dom";

export default function Navbar() {
  const location = useLocation();

  return (
    <nav className="navbar">
      <div className="navbar-container">
        <div className="navbar-logo">
          <span className="logo-icon">◉</span>
          <span className="logo-text">Crypto Analytics</span>
        </div>

        <div className="navbar-links">
          <Link
            to="/"
            className={`nav-link ${location.pathname === "/" ? "active-link" : ""}`}
          >
            Home
          </Link>

          <Link
            to="/dashboard"
            className={`nav-link ${location.pathname === "/dashboard" ? "active-link" : ""}`}
          >
            Dashboard
          </Link>

          <a href="#documentation" className="nav-link">
            Documentation
          </a>

          <a href="#project-info" className="nav-link">
            Project Info
          </a>
        </div>
      </div>
    </nav>
  );
}