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

          <Link
            to="/documentation"
            className={`nav-link ${location.pathname === "/documentation" ? "active-link" : ""}`}
          >
            Documentation
          </Link>


          <Link
            to="/project-info"
            className={`nav-link ${location.pathname === "/project-info" ? "active-link" : ""}`}
          >
            Project Info
          </Link>
        </div>
      </div>
    </nav>
  );
}