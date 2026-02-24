

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { ensureAnonAuth } from "../auth";
import Card from "../components/Card";
import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import { writeBatch } from "firebase/firestore";
import { createEuchreDeck, shuffle } from "../lib/deal";

type Seat = "N" | "E" | "S" | "W";

const SEATS: Seat[] = ["N", "E", "S", "W"];

const actionPanelStyle: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 12,
  padding: 12,
  background: "white",
  marginTop: 12,
};

function nextSeat(seat: Seat): Seat {
  const i = SEATS.indexOf(seat);
  return SEATS[(i + 1) % SEATS.length];
}

function suitCharFromCard(code: CardCode): "S" | "H" | "D" | "C" {
  return code[1] as any;
}

type GameDoc = {
  status: string;
  phase?: "lobby" | "bidding_round_1" | "bidding_round_2" | "playing";
  seats: Record<Seat, string | null>;
  dealer: Seat;
  turn: Seat;
  score: { NS: number; EW: number };
  handNumber: number;
  upcard?: CardCode;
  trump?: "S" | "H" | "D" | "C" | null;
  makerSeat?: Seat | null;
  bidding?: {
    round: number;
    passes: Seat[];
    orderedUpBy: Seat | null;
  };
};

type PlayerDoc = {
  uid: string;
  name: string;
  seat: Seat;
  joinedAt: any;
};

export default function Game() {
  const { gameId } = useParams();
  const [game, setGame] = useState<GameDoc | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [myHand, setMyHand] = useState<CardCode[]>([]);

  useEffect(() => {
    if (!gameId || !uid) return;

    const playerRef = doc(db, "games", gameId, "players", uid);

    const unsub = onSnapshot(playerRef, (snap) => {
      if (!snap.exists()) {
        setMyHand([]);
        return;
      }
      const data = snap.data() as any;
      setMyHand((data.hand ?? []) as CardCode[]);
    });

    return () => unsub();
  }, [gameId, uid]);

  const mySeat: Seat | null =
  uid && game
  ? ((Object.entries(game.seats).find(([, v]) => v === uid)?.[0] as
    | Seat
    | undefined) ?? null)
  : null;

  async function dealTestHand() {
    if (!gameId || !uid) return;

    const playerRef = doc(db, "games", gameId, "players", uid);

    const hand: CardCode[] = ["AS", "KH", "QC", "JD", "TS"];

    await setDoc(
      playerRef,
      {
        uid,
        name: localStorage.getItem("playerName") || "Player",
        seat: mySeat ?? "N",
        joinedAt: serverTimestamp(),
        hand,
      },
      { merge: true }
      );
  }

  const [players, setPlayers] = useState<Record<string, PlayerDoc>>({});

  const [selectedCard, setSelectedCard] = useState<number | null>(null);
  const fakeHand = [
    { rank: "A", suit: "♠" },
    { rank: "K", suit: "♥" },
    { rank: "Q", suit: "♣" },
    { rank: "J", suit: "♦" },
    { rank: "10", suit: "♠" },
  ];

  const gameRef = useMemo(
    () => (gameId ? doc(db, "games", gameId) : null),
    [gameId]
    );

  useEffect(() => {
    ensureAnonAuth()
    .then((u) => setUid(u.uid))
    .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!gameRef) return;
    const unsub = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) {
          setGame(null);
          setErr("Game not found (check the id).");
          return;
        }
        setErr(null);
        setGame(snap.data() as GameDoc);
      },
      (e) => setErr(String(e))
      );

    return () => unsub();
  }, [gameRef]);

  useEffect(() => {
    if (!gameId) return;

    const unsub = onSnapshot(
      collection(db, "games", gameId, "players"),
      (snap) => {
        const p: Record<string, PlayerDoc> = {};
        snap.forEach((d) => {
          p[d.id] = d.data() as PlayerDoc;
        });
        setPlayers(p);
      },
      (e) => setErr(String(e))
      );

    return () => unsub();
  }, [gameId]);

  async function claimSeat(seat: Seat) {
    if (!gameRef || !uid) return;

    try {
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(gameRef);
        if (!snap.exists()) throw new Error("Game missing");

        const data = snap.data() as GameDoc;

        if (data.seats[seat]) throw new Error("Seat already taken");
        if (Object.values(data.seats).includes(uid))
          throw new Error("You already claimed a seat");

        transaction.update(gameRef, {
          [`seats.${seat}`]: uid,
          updatedAt: serverTimestamp(),
        });
      });
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  async function startHand() {
    if (!gameId || !uid || !gameRef || !game) return;

    const allFilled = (["N", "E", "S", "W"] as Seat[]).every((s) => !!game.seats[s]);
    if (!allFilled) {
      setErr("Need all 4 seats filled to start a hand.");
      return;
    }

    const dealer: Seat = game.dealer ? nextSeat(game.dealer) : "N";
    const firstToAct: Seat = nextSeat(dealer); 
    const deck = shuffle(createEuchreDeck());

    const order: Seat[] = [];
    let s = nextSeat(dealer);
    for (let i = 0; i < 4; i++) {
      order.push(s);
      s = nextSeat(s);
    }

    const hands: Record<Seat, CardCode[]> = { N: [], E: [], S: [], W: [] };

    let idx = 0;
    for (let c = 0; c < 5; c++) {
      for (const s of order) {
        hands[s].push(deck[idx++] as CardCode);
      }
    }

    const upcard = deck[idx++] as CardCode;

    const kitty = deck.slice(idx) as CardCode[];

    const batch = writeBatch(db);

    batch.update(gameRef, {
      status: "bidding",
      phase: "bidding_round_1",
      bidding: { round: 1, passes: [], orderedUpBy: null },
      trump: null,
      makerSeat: null,

      updatedAt: serverTimestamp(),
      dealer,
      turn: firstToAct,
      upcard,
      kitty,
      handNumber: (game.handNumber ?? 0) + 1,
    });

    for (const s of (["N", "E", "S", "W"] as Seat[])) {
      const seatUid = game.seats[s]!;

      const playerRef = doc(db, "games", gameId, "players", seatUid);

      batch.set(
        playerRef,
        {
          uid: seatUid,
          name: players[seatUid]?.name ?? "Player",
          seat: s,
          hand: hands[s],
          joinedAt: serverTimestamp(),
        },
        { merge: true }
        );
    }

    async function bidPass() {
      if (!gameRef || !game || !mySeat) return;
      if (game.phase !== "bidding_round_1") return;
      if (game.turn !== mySeat) return;

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(gameRef);
        if (!snap.exists()) throw new Error("Game missing");
        const g = snap.data() as GameDoc;

        if (g.phase !== "bidding_round_1") return;
        if (g.turn !== mySeat) return;

        const passes = g.bidding?.passes ?? [];
        const nextPasses = passes.includes(mySeat) ? passes : [...passes, mySeat];

    // Everyone passed -> go to round 2
        if (nextPasses.length >= 4) {
          tx.update(gameRef, {
            phase: "bidding_round_2",
            bidding: { round: 2, passes: [], orderedUpBy: null },
            updatedAt: serverTimestamp(),
        // turn should reset to firstToAct (left of dealer)
            turn: nextSeat(g.dealer),
          });
          return;
        }

        tx.update(gameRef, {
          bidding: {
            round: 1,
            passes: nextPasses,
            orderedUpBy: null,
          },
          updatedAt: serverTimestamp(),
          turn: nextSeat(g.turn),
        });
      });
    }

    async function bidOrderUp() {
      if (!gameRef || !game || !mySeat) return;
      if (game.phase !== "bidding_round_1") return;
      if (game.turn !== mySeat) return;
      if (!game.upcard) return;

      const trump = suitCharFromCard(game.upcard);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(gameRef);
        if (!snap.exists()) throw new Error("Game missing");
        const g = snap.data() as GameDoc;

        if (g.phase !== "bidding_round_1") return;
        if (g.turn !== mySeat) return;
        if (!g.upcard) return;

        const t = suitCharFromCard(g.upcard);

        tx.update(gameRef, {
          phase: "playing",
          trump: t,
          makerSeat: mySeat,
          bidding: {
            round: 1,
            passes: g.bidding?.passes ?? [],
            orderedUpBy: mySeat,
          },
          updatedAt: serverTimestamp(),
      // First trick lead is left of dealer
          turn: nextSeat(g.dealer),
        });
      });
    }

    await batch.commit();
    setErr(null);
  }

  const url = typeof window !== "undefined" ? window.location.href : "";

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>Game</h3>

      {err && <div style={alertStyle}>{err}</div>}

        <div style={{ marginBottom: 12 }}>
          <div>
            <b>Game ID:</b> {gameId}
          </div>
          <div style={{ marginTop: 8 }}>
            <b>Share link:</b>
            <input readOnly value={url} style={shareStyle} />
          </div>
        </div>
        <button onClick={dealTestHand} style={{ ...btnStyle, marginBottom: 12 }}>
          Deal Test Hand (me)
        </button>
        <button
          onClick={startHand}
          disabled={!game || mySeat !== "N"}
          style={{ ...btnStyle, width: "100%", marginBottom: 12 }}
        >
          Start Hand (Deal)
        </button>
        {!game ? (
          <p>Loading…</p>
          ) : (
          <>
          <div style={cardStyle}>
            <div>
              <b>Status:</b> {game.status}
            </div>
            <div>
              <b>Hand #:</b> {game.handNumber}
            </div>
            <div>
              <b>Dealer:</b> {game.dealer}
            </div>
            <div>
              <b>Turn:</b> {game.turn}
            </div>
            <div>
              <b>Score:</b> NS {game.score.NS} — EW {game.score.EW}
            </div>
          </div>

          <h4>Seats</h4>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: 10,
            }}
          >
            {(["N", "E", "S", "W"] as Seat[]).map((s) => {
              const seatUid = game.seats[s];
              const seatName = seatUid ? players[seatUid]?.name || "Taken" : "Open";

              return (
                <div key={s} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <b>{s}</b>
                    {mySeat === s && (
                      <span style={{ fontSize: 12, color: "#0a7" }}>You</span>
                      )}
                  </div>

                  <div style={{ marginTop: 8, color: "#555" }}>{seatName}</div>

                  <button
                    onClick={() => claimSeat(s)}
                    disabled={!uid || !!game.seats[s] || !!mySeat}
                    style={{ ...btnStyle, marginTop: 10, width: "100%" }}
                  >
                    Claim
                  </button>
                </div>
                );
            })}
          </div>
          {(game as any).upcard && (
            <div style={{ marginTop: 12 }}>
              <b>Upcard</b>
              <div style={{ marginTop: 8 }}>
                {(() => {
                  const { rank, suit } = parseCard((game as any).upcard);
                  return <Card rank={rankLabel(rank)} suit={suitSymbol(suit)} />;
                })()}
              </div>
            </div>
            )}

          {game?.phase === "bidding_round_1" && (
            <div style={actionPanelStyle}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>
                {game.turn === mySeat ? "Your turn to bid" : `Waiting for ${game.turn}`}
              </div>

              <div style={{ marginBottom: 10, color: "#555" }}>
                Order up the upcard suit?
              </div>

              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={bidOrderUp}
                  disabled={game.turn !== mySeat}
                  style={{ ...btnStyle, flex: 1, padding: "14px 14px" }}
                >
                  Order Up
                </button>

                <button
                  onClick={bidPass}
                  disabled={game.turn !== mySeat}
                  style={{ ...btnStyle, flex: 1, padding: "14px 14px" }}
                >
                  Pass
                </button>
              </div>
            </div>
            )}

          <h4 style={{ marginTop: 24 }}>Your Hand</h4>

          <div
            style={{
              display: "flex",
              gap: 10,
              overflowX: "auto",
              paddingBottom: 8,
            }}
          >
            {myHand.map((code, i) => {
              const { rank, suit } = parseCard(code);
              return (
                <Card
                  key={code + i}
                  rank={rankLabel(rank)}
                  suit={suitSymbol(suit)}
                  selected={selectedCard === i}
                  onClick={() => setSelectedCard(selectedCard === i ? null : i)}
                  />
                  );
            })}
          </div>

          </>
          )}
        </div>
        );
}

const alertStyle: React.CSSProperties = {
  padding: 12,
  background: "#fff3cd",
  border: "1px solid #ffecb5",
  borderRadius: 10,
  marginBottom: 12,
};

const cardStyle: React.CSSProperties = {
  padding: 12,
  border: "1px solid #ddd",
  borderRadius: 12,
  background: "white",
};

const btnStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid #ccc",
  background: "white",
  cursor: "pointer",
};

const shareStyle: React.CSSProperties = {
  width: "100%",
  padding: 8,
  borderRadius: 8,
  border: "1px solid #ccc",
  marginTop: 6,
};