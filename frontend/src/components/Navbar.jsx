import { Link } from "react-router-dom";

export default function Navbar() {
  return (
    <nav className="navbar">
      <div className="navbar-container">
        <div className="navbar-logo">
          <span className="logo-icon">◉</span>
          <span className="logo-text">Crypto Analytics</span>
        </div>

        <div className="navbar-links">
          <Link to="/" className="nav-link active-link">
            Home
          </Link>
          <a href="#dashboard-preview" className="nav-link">
            Dashboard
          </a>
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