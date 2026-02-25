import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  collection,
  doc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";

import { db } from "../firebase";
import { ensureAnonAuth } from "../auth";

import Card from "../components/Card";
import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import { createEuchreDeck, shuffle } from "../lib/deal";

/**
 * ==========================================================
 * Types / Constants / Helpers
 * ==========================================================
 */

type Seat = "N" | "E" | "S" | "W";

const SEATS: Seat[] = ["N", "E", "S", "W"];

function nextSeat(seat: Seat): Seat {
  const i = SEATS.indexOf(seat);
  return SEATS[(i + 1) % SEATS.length];
}

function suitCharFromCard(code: CardCode): "S" | "H" | "D" | "C" {
  return code[1] as any;
}

type GameDoc = {
  /** Legacy-ish high-level state. We’re migrating toward `phase`. */
  status: string;

  /** Phase state machine (so UI + rules stay predictable). */
  phase?: "lobby" | "bidding_round_1" | "bidding_round_2" | "playing";

  /** Seat map: each seat stores the player’s UID (or null if open). */
  seats: Record<Seat, string | null>;

  dealer: Seat;
  turn: Seat;

  score: { NS: number; EW: number };
  handNumber: number;

  upcard?: CardCode;
  kitty?: CardCode[];
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
  name?: string;
  seat?: Seat;
  joinedAt?: any;
  hand?: CardCode[];
};

/**
 * ==========================================================
 * Game Screen
 * - Owns realtime subscriptions for the game + players + my hand
 * - Provides actions for claiming seats, dealing, and bidding round 1
 * ==========================================================
 */
export default function Game() {
  /**
   * ----------------------------------------------------------
   * Routing
   * ----------------------------------------------------------
   */
  const { gameId } = useParams();

  /**
   * ----------------------------------------------------------
   * Local UI State
   * ----------------------------------------------------------
   */
  const [err, setErr] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<number | null>(null);

  /**
   * ----------------------------------------------------------
   * Auth + Firestore State
   * ----------------------------------------------------------
   */
  const [uid, setUid] = useState<string | null>(null);
  const [game, setGame] = useState<GameDoc | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerDoc>>({});
  const [myHand, setMyHand] = useState<CardCode[]>([]);

  /**
   * ----------------------------------------------------------
   * Derived Values
   * ----------------------------------------------------------
   */
  const mySeat: Seat | null =
    uid && game
      ? ((Object.entries(game.seats).find(([, v]) => v === uid)?.[0] as Seat | undefined) ?? null)
      : null;

  const url = typeof window !== "undefined" ? window.location.href : "";

  /**
   * ----------------------------------------------------------
   * Firestore References
   * ----------------------------------------------------------
   */
  const gameRef = useMemo(() => (gameId ? doc(db, "games", gameId) : null), [gameId]);

  /**
   * ==========================================================
   * Effects (order matters for readability)
   * 1) Auth
   * 2) Subscribe to game doc
   * 3) Subscribe to players
   * 4) Subscribe to *my* player doc for private hand
   * ==========================================================
   */

  // 1) Anonymous auth (persists per browser profile)
  useEffect(() => {
    ensureAnonAuth()
      .then((u) => setUid(u.uid))
      .catch((e) => setErr(String(e)));
  }, []);

  // 2) Game doc subscription (shared public state)
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

  // 3) Players subcollection subscription (names/seat metadata)
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

  // 4) My private player doc subscription (only *my* hand)
  useEffect(() => {
    if (!gameId || !uid) return;

    const playerRef = doc(db, "games", gameId, "players", uid);

    const unsub = onSnapshot(
      playerRef,
      (snap) => {
        if (!snap.exists()) {
          setMyHand([]);
          return;
        }
        const data = snap.data() as PlayerDoc;
        setMyHand((data.hand ?? []) as CardCode[]);
      },
      (e) => setErr(String(e))
    );

    return () => unsub();
  }, [gameId, uid]);

  /**
   * ==========================================================
   * Actions
   * ==========================================================
   */

  /** Claim a seat in the public game doc (transaction), then upsert my player profile. */
  async function claimSeat(seat: Seat) {
    if (!gameRef || !uid || !gameId) return;

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(gameRef);
        if (!snap.exists()) throw new Error("Game missing");

        const data = snap.data() as GameDoc;

        if (data.seats[seat]) throw new Error("Seat already taken");
        if (Object.values(data.seats).includes(uid)) throw new Error("You already claimed a seat");

        tx.update(gameRef, {
          [`seats.${seat}`]: uid,
          updatedAt: serverTimestamp(),
        });
      });

      // Create/update my player doc so other people can see a name.
      await setDoc(
        doc(db, "games", gameId, "players", uid),
        {
          uid,
          name: localStorage.getItem("playerName") || "Player",
          seat,
          joinedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  /** Debug button: deals a hard-coded hand to *me* only. */
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
        hand,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  /** Start a hand: shuffle, deal 5 cards each, set upcard/kitty, enter bidding round 1. */
  async function startHand() {
    if (!gameId || !uid || !gameRef || !game) return;

    const allFilled = (["N", "E", "S", "W"] as Seat[]).every((seat) => !!game.seats[seat]);
    if (!allFilled) {
      setErr("Need all 4 seats filled to start a hand.");
      return;
    }

    // Rotate dealer each hand (simple rule; we can change later)
    const dealer: Seat = game.dealer ? nextSeat(game.dealer) : "N";
    const firstToAct: Seat = nextSeat(dealer); // left of dealer

    const deck = shuffle(createEuchreDeck());

    // Deal clockwise starting left of dealer
    const order: Seat[] = [];
    let cursor = nextSeat(dealer);
    for (let i = 0; i < 4; i++) {
      order.push(cursor);
      cursor = nextSeat(cursor);
    }

    const hands: Record<Seat, CardCode[]> = { N: [], E: [], S: [], W: [] };

    let idx = 0;
    for (let c = 0; c < 5; c++) {
      for (const seat of order) {
        hands[seat].push(deck[idx++] as CardCode);
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

    // Write hands to each player doc keyed by UID (private hands)
    for (const seat of (["N", "E", "S", "W"] as Seat[])) {
      const seatUid = game.seats[seat]!;
      const playerRef = doc(db, "games", gameId, "players", seatUid);

      batch.set(
        playerRef,
        {
          uid: seatUid,
          name: players[seatUid]?.name ?? "Player",
          seat,
          hand: hands[seat],
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    await batch.commit();
    setErr(null);
  }

  /** Bidding round 1: current player passes */
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

      // Everyone passed -> enter round 2 (we’ll implement next)
      if (nextPasses.length >= 4) {
        tx.update(gameRef, {
          phase: "bidding_round_2",
          bidding: { round: 2, passes: [], orderedUpBy: null },
          updatedAt: serverTimestamp(),
          turn: nextSeat(g.dealer),
        });
        return;
      }

      tx.update(gameRef, {
        bidding: { round: 1, passes: nextPasses, orderedUpBy: null },
        updatedAt: serverTimestamp(),
        turn: nextSeat(g.turn),
      });
    });
  }

  /** Bidding round 1: current player orders up (trump becomes upcard suit) */
  async function bidOrderUp() {
    if (!gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_1") return;
    if (game.turn !== mySeat) return;
    if (!game.upcard) return;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game missing");
      const g = snap.data() as GameDoc;

      if (g.phase !== "bidding_round_1") return;
      if (g.turn !== mySeat) return;
      if (!g.upcard) return;

      const trump = suitCharFromCard(g.upcard);

      // Next: dealer must pick up + discard. For now, we jump straight to playing.
      tx.update(gameRef, {
        phase: "playing",
        trump,
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

  /**
   * ==========================================================
   * Render
   * ==========================================================
   */
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

      {/* Debug-only button */}
      <button onClick={dealTestHand} style={{ ...btnStyle, marginBottom: 12 }}>
        Deal Test Hand (me)
      </button>

      {/* Host-only for now: N starts the hand */}
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
          {/* Public/shared game summary */}
          <div style={cardStyle}>
            <div>
              <b>Status:</b> {game.status}
            </div>
            <div>
              <b>Phase:</b> {game.phase ?? "lobby"}
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

            {game.upcard && (
              <div style={{ marginTop: 8 }}>
                <b>Upcard:</b> {game.upcard}
              </div>
            )}
          </div>

          {/* Bidding UI (Round 1) */}
          {game.phase === "bidding_round_1" && (
            <div style={{ ...cardStyle, marginTop: 12 }}>
              <h4 style={{ marginTop: 0 }}>Bidding (Round 1)</h4>

              <div style={{ marginBottom: 8 }}>
                <b>Current turn:</b> {game.turn}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={bidOrderUp} disabled={mySeat !== game.turn} style={btnStyle}>
                  Order Up
                </button>
                <button onClick={bidPass} disabled={mySeat !== game.turn} style={btnStyle}>
                  Pass
                </button>
              </div>
            </div>
          )}

          {/* Seat selection / lobby */}
          <h4>Seats</h4>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10 }}>
            {(["N", "E", "S", "W"] as Seat[]).map((seat) => {
              const seatUid = game.seats[seat];
              const seatName = seatUid ? players[seatUid]?.name || "Taken" : "Open";

              return (
                <div key={seat} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <b>{seat}</b>
                    {mySeat === seat && <span style={{ fontSize: 12, color: "#0a7" }}>You</span>}
                  </div>

                  <div style={{ marginTop: 8, color: "#555" }}>{seatName}</div>

                  <button
                    onClick={() => claimSeat(seat)}
                    disabled={!uid || !!game.seats[seat] || !!mySeat}
                    style={{ ...btnStyle, marginTop: 10, width: "100%" }}
                  >
                    Claim
                  </button>
                </div>
              );
            })}
          </div>

          {/* My private hand */}
          <h4 style={{ marginTop: 24 }}>Your Hand</h4>
          <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8 }}>
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

/**
 * ==========================================================
 * Styles
 * (Kept inline for now; later we can move to CSS modules/Tailwind)
 * ==========================================================
 */

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
