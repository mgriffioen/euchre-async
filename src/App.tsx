import { Routes, Route, Link } from "react-router-dom";
import Home from "./screens/Home";
import Game from "./screens/Game";

export default function App() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 16 }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <Link to="/" style={{ textDecoration: "none" }}>
          <h2 style={{ margin: 0 }}>Async Euchre</h2>
        </Link>
      </header>

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/g/:gameId" element={<Game />} />
      </Routes>
    </div>
  );
}