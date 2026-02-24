import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { addDoc, collection, doc, setDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { ensureAnonAuth } from "../auth";

type Seat = "N" | "E" | "S" | "W";

type GameDoc = {
  createdAt: any;
  updatedAt: any;
  status: "lobby";
  seats: Record<Seat, string | null>;
  dealer: Seat;
  turn: Seat;
  score: { NS: number; EW: number };
  handNumber: number;
};

export default function Home() {
  const nav = useNavigate();

  const [name, setName] = useState(() => localStorage.getItem("playerName") || "");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createGame() {
    setBusy(true);
    setError(null);
    try {
      const user = await ensureAnonAuth();

      const newGame: GameDoc = {
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        status: "lobby",
        seats: { N: user.uid, E: null, S: null, W: null },
        dealer: "N",
        turn: "N",
        score: { NS: 0, EW: 0 },
        handNumber: 1,
      };

      const ref = await addDoc(collection(db, "games"), newGame);

      await setDoc(doc(db, "games", ref.id, "players", user.uid), {
        uid: user.uid,
        name: name || "Player",
        seat: "N",
        joinedAt: serverTimestamp(),
      });

      nav(`/g/${ref.id}`);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function joinGame() {
    const trimmed = joinCode.trim();
    if (!trimmed) return;
    nav(`/g/${trimmed}`);
  }

  return (
    <div>
      <p style={{ marginTop: 0 }}>Create a game, then share the URL with friends.</p>

      {error && (
        <div style={{ padding: 12, borderRadius: 10, border: "1px solid #f5c2c7", background: "#f8d7da" }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            localStorage.setItem("playerName", e.target.value);
          }}
          placeholder="Your name"
          style={inputStyle}
        />
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <button onClick={createGame} disabled={busy} style={btnStyle}>
          {busy ? "Creating..." : "Create Game"}
        </button>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
            placeholder="Paste game id…"
            style={inputStyle}
          />
          <button onClick={joinGame} style={btnStyle}>
            Join
          </button>
        </div>
      </div>

      <hr style={{ margin: "24px 0" }} />

      <p style={{ color: "#555" }}>
        For now we use the Firestore document id as the join code. We’ll add short codes later.
      </p>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid #ccc",
  background: "white",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #ccc",
  minWidth: 260,
};