import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Documentation from "./pages/Documentation";
import ProjectInfo from "./pages/ProjectInfo";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/documentation" element={<Documentation />} />
      <Route path="/project-info" element={<ProjectInfo />} />
    </Routes>
  );
}