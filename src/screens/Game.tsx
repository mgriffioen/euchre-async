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
 * Types / Constants
 * ==========================================================
 */

type Seat = "N" | "E" | "S" | "W";
type Suit = "S" | "H" | "D" | "C";

const SEATS: Seat[] = ["N", "E", "S", "W"];
const SUITS: Suit[] = ["S", "H", "D", "C"];

type GamePhase =
| "lobby"
| "bidding_round_1"
| "bidding_round_2"
| "dealer_discard"
| "playing";

type GameDoc = {
  /** Legacy-ish high-level state. We’re migrating toward `phase`. */
  status: string;

  /** Phase state machine (so UI + rules stay predictable). */
  phase?: GamePhase;

  /** Seat map: each seat stores the player’s UID (or null if open). */
  seats: Record<Seat, string | null>;

  dealer: Seat;
  turn: Seat;

  score: { NS: number; EW: number };
  handNumber: number;

  upcard?: CardCode;
  kitty?: CardCode[];
  trump?: Suit | null;
  makerSeat?: Seat | null;

  bidding?: {
    round: 1 | 2;
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
 * Pure Helpers (no React state)
 * ==========================================================
 */

function nextSeat(seat: Seat): Seat {
  const i = SEATS.indexOf(seat);
  return SEATS[(i + 1) % SEATS.length];
}

function suitCharFromCard(code: CardCode): Suit {
  return code[1] as Suit;
}

/**
 * Seat rotation:
 * - Firestore stores "REAL" seats (N/E/S/W) consistently for everyone.
 * - UI can "DISPLAY" seats rotated so that "mySeat" is always shown at South.
 */
function seatIndex(seat: Seat): number {
  return SEATS.indexOf(seat); // N=0, E=1, S=2, W=3
}

function rotationOffsetToMakeMySeatSouth(my: Seat): number {
  const southIdx = seatIndex("S"); // 2
  const myIdx = seatIndex(my);
  return (southIdx - myIdx + 4) % 4;
}

function realToDisplaySeat(real: Seat, my: Seat): Seat {
  const off = rotationOffsetToMakeMySeatSouth(my);
  return SEATS[(seatIndex(real) + off) % 4];
}

/**
 * ==========================================================
 * Game Screen
 * - Owns realtime subscriptions for the game + players + my hand
 * - Provides actions for claiming seats, dealing, and bidding
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
   * Firestore References
   * ----------------------------------------------------------
   */
  const gameRef = useMemo(() => (gameId ? doc(db, "games", gameId) : null), [gameId]);

  /**
   * ----------------------------------------------------------
   * Derived Values (REAL seats)
   * ----------------------------------------------------------
   */
  const mySeat: Seat | null =
  uid && game
  ? ((Object.entries(game.seats).find(([, v]) => v === uid)?.[0] as Seat | undefined) ?? null)
  : null;

  const isMyTurn = !!uid && !!game && !!mySeat && game.turn === mySeat;

  const upcardSuit: Suit | null = game?.upcard ? suitCharFromCard(game.upcard) : null;

  const round2AllowedSuits: Suit[] = upcardSuit ? SUITS.filter((s) => s !== upcardSuit) : SUITS;

  const isDealerStuck: boolean =
  !!game &&
  game.phase === "bidding_round_2" &&
  game.bidding?.round === 2 &&
  (game.bidding?.passes?.length ?? 0) === 3 &&
  game.turn === game.dealer;

  /**
   * ----------------------------------------------------------
   * Derived Values (DISPLAY seats)
   * ----------------------------------------------------------
   */
  const displaySeat = (real: Seat): Seat => {
    if (!mySeat) return real;
    return realToDisplaySeat(real, mySeat);
  };

  // Rotate commonly displayed seats
  const displayDealer: Seat | null = game?.dealer ? displaySeat(game.dealer) : null;
  const displayTurn: Seat | null = game?.turn ? displaySeat(game.turn) : null;
  const displayMakerSeat: Seat | null = game?.makerSeat ? displaySeat(game.makerSeat) : null;

  // Rotate passes for bidding UI text
  const displayPasses: Seat[] = (game?.bidding?.passes ?? []).map((s) => displaySeat(s as Seat));

  // Map DISPLAY -> REAL for seat cards (Claim buttons)
  const displaySeats: Record<Seat, Seat> = useMemo(() => {
    // displaySeats[DISPLAY] = REAL
    if (!mySeat) return { N: "N", E: "E", S: "S", W: "W" };

    const m: Record<Seat, Seat> = { N: "N", E: "E", S: "S", W: "W" };
    (SEATS as Seat[]).forEach((real) => {
      const display = realToDisplaySeat(real, mySeat);
      m[display] = real;
    });
    return m;
  }, [mySeat]);

  // Display names: keep lookup by REAL seat/uid, but fallback to DISPLAY letter
  const turnName =
  game?.turn && game.seats[game.turn]
  ? players[game.seats[game.turn] as string]?.name || (displayTurn ?? game.turn)
  : displayTurn ?? game?.turn;

  const seatLabel = (realSeat: Seat) => {
    if (!game) return "Open";
    const seatUid = game.seats[realSeat];
    if (!seatUid) return "Open";
    return players[seatUid]?.name || "Taken";
  };

  const url = typeof window !== "undefined" ? window.location.href : "";

  /**
   * ==========================================================
   * Effects
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

        const trump = suitCharFromCard(g.upcard);

        tx.update(gameRef, {
          status: "bidding",
          phase: "dealer_discard",
          trump,
          makerSeat: mySeat,
          bidding: {
            round: 1,
            passes: g.bidding?.passes ?? [],
            orderedUpBy: mySeat,
          },
          updatedAt: serverTimestamp(),

          // Dealer must act now
          turn: g.dealer,
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

  /** Start a hand: shuffle, deal 5 cards each, set upcard/kitty, enter bidding round 1. */
  async function startHand() {
    if (!gameId || !uid || !gameRef || !game) return;

    const allFilled = (SEATS as Seat[]).every((seat) => !!game.seats[seat]);
    if (!allFilled) {
      setErr("Need all 4 seats filled to start a hand.");
      return;
    }

    // Rotate dealer each hand (simple rule; can change later)
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
      phase: "bidding_round_1" satisfies GamePhase,
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
    for (const seat of SEATS as Seat[]) {
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
  async function bidPassRound1() {
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

      // Everyone passed -> enter round 2 and reset passes.
      if (nextPasses.length >= 4) {
        tx.update(gameRef, {
          phase: "bidding_round_2",
          bidding: { round: 2, passes: [], orderedUpBy: null },
          updatedAt: serverTimestamp(),
          // Round 2 starts again left of dealer
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

  /** Bidding round 2 ("screw the dealer") */
  async function bidPassRound2() {
    if (!gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_2") return;
    if (game.turn !== mySeat) return;

    // Dealer is not allowed to pass when they are stuck.
    if (mySeat === game.dealer) {
      setErr("Screw the dealer: dealer must choose a trump suit.");
      return;
    }

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game missing");
      const g = snap.data() as GameDoc;

      if (g.phase !== "bidding_round_2") return;
      if (g.turn !== mySeat) return;

      // If dealer somehow got the turn here, don’t allow passing.
      if (mySeat === g.dealer) return;

      const passes = g.bidding?.passes ?? [];
      const nextPasses = passes.includes(mySeat) ? passes : [...passes, mySeat];

      // After 3 passes (everyone except dealer), force dealer turn.
      if (nextPasses.length >= 3) {
        tx.update(gameRef, {
          bidding: { round: 2, passes: nextPasses, orderedUpBy: null },
          updatedAt: serverTimestamp(),
          turn: g.dealer,
        });
        return;
      }

      tx.update(gameRef, {
        bidding: { round: 2, passes: nextPasses, orderedUpBy: null },
        updatedAt: serverTimestamp(),
        turn: nextSeat(g.turn),
      });
    });
  }

  /** Bidding round 2: call trump (any suit except upcard suit) */
  async function bidCallTrump(suit: Suit) {
    if (!gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_2") return;
    if (game.turn !== mySeat) return;
    if (!game.upcard) return;

    const forbidden = suitCharFromCard(game.upcard);
    if (suit === forbidden) {
      setErr("You can’t choose the upcard suit in round 2.");
      return;
    }

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game missing");
      const g = snap.data() as GameDoc;

      if (g.phase !== "bidding_round_2") return;
      if (g.turn !== mySeat) return;
      if (!g.upcard) return;

      const forbiddenSuit = suitCharFromCard(g.upcard);
      if (suit === forbiddenSuit) return;

      tx.update(gameRef, {
        phase: "playing",
        trump: suit,
        makerSeat: mySeat,
        bidding: {
          round: 2,
          passes: g.bidding?.passes ?? [],
          orderedUpBy: null,
        },
        updatedAt: serverTimestamp(),
        turn: nextSeat(g.dealer),
      });
    });
  }

  /** Trump declared, dealer picks up and discards */
  async function dealerPickupAndDiscard(discard: CardCode) {
    if (!gameRef || !gameId || !game || !uid || !mySeat) return;

  // Only dealer can do this
    if (game.phase !== "dealer_discard") return;
    if (mySeat !== game.dealer) return;
    if (game.turn !== game.dealer) return;
    if (!game.upcard) return;

    const dealerUid = game.seats[game.dealer];
    if (!dealerUid) return;

    const dealerPlayerRef = doc(db, "games", gameId, "players", dealerUid);

    try {
      await runTransaction(db, async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists()) throw new Error("Game missing");
        const g = gameSnap.data() as GameDoc;

        if (g.phase !== "dealer_discard") return;
        if (g.turn !== g.dealer) return;
        if (!g.upcard) return;

        const dealerUid2 = g.seats[g.dealer];
        if (!dealerUid2) throw new Error("Dealer missing");
        const dealerRef2 = doc(db, "games", gameId, "players", dealerUid2);

        const playerSnap = await tx.get(dealerRef2);
        if (!playerSnap.exists()) throw new Error("Dealer player doc missing");
        const p = playerSnap.data() as PlayerDoc;

        const hand = (p.hand ?? []) as CardCode[];
        if (hand.length !== 5) throw new Error("Dealer hand not 5 cards");

      // Dealer picks up the upcard -> 6 cards, then discards 1 (can discard the upcard too)
        const combined: CardCode[] = [...hand, g.upcard];

        const discardIdx = combined.indexOf(discard);
        if (discardIdx === -1) throw new Error("Discard card not found");

        const nextHand = combined.slice();
        nextHand.splice(discardIdx, 1);

        if (nextHand.length !== 5) throw new Error("Resulting hand not 5 cards");

        const nextKitty = [...(g.kitty ?? []), discard];

        tx.update(dealerRef2, {
          hand: nextHand,
          updatedAt: serverTimestamp(),
        });

        tx.update(gameRef, {
          status: "playing",
          phase: "playing",
          kitty: nextKitty,
        // optional: keep upcard for history; OR clear it:
        // upcard: null,
          updatedAt: serverTimestamp(),
        turn: nextSeat(g.dealer), // first lead left of dealer
      });
      });

      setErr(null);
      setSelectedCard(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
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
          {/* Turn Banner */}
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              marginBottom: 12,
              background: isMyTurn ? "#d1e7dd" : "#f8f9fa",
              border: `1px solid ${isMyTurn ? "#badbcc" : "#ddd"}`,
              fontWeight: 600,
            }}
          >
            {game.phase?.startsWith("bidding") ? (
              isMyTurn ? (
                <>
                🟢{" "}
                {game.phase === "bidding_round_2" &&
                (game.bidding?.passes?.length ?? 0) === 3 &&
                mySeat === game.dealer
                ? "Dealer must choose trump"
                : "Your turn to bid"}
                </>
                ) : (
                <>⏳ Waiting for {turnName} to bid…</>
                )
                ) : game.phase === "dealer_discard" ? (
                mySeat === game.dealer ? (
                  <>🟢 Dealer: pick up the upcard and discard</>
                  ) : (
                  <>⏳ Waiting for dealer ({displayDealer ?? game.dealer}) to discard…</>
                  )
                  ) : game.phase === "playing" ? (
                  isMyTurn ? (
                    <>🟢 Your turn</>
                    ) : (
                    <>⏳ Waiting for {turnName}…</>
                    )
                    ) : (
                    <>Waiting…</>
                    )}
                  </div>

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
                      <b>Dealer:</b> {displayDealer ?? game.dealer}
                    </div>
                    <div>
                      <b>Turn:</b> {displayTurn ?? game.turn}
                    </div>
                    <div>
                      <b>Score:</b> NS {game.score.NS} — EW {game.score.EW}
                    </div>

            {/* Upcard during bidding */}
                    {game.upcard && game.phase !== "playing" && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ marginBottom: 10 }}>
                          <b>Upcard:</b>
                        </div>
                        {(() => {
                          const { rank, suit } = parseCard(game.upcard as CardCode);
                          return (
                            <Card
                              rank={rankLabel(rank)}
                              suit={suitSymbol(suit)}
                              selected={false}
                              onClick={() => {}}
                              />
                              );
                        })()}
                      </div>
                      )}

            {/* Trump once bidding is complete */}
                    {game.phase === "playing" && game.trump && (
                      <div style={{ marginTop: 10 }}>
                        <b>Trump:</b> {suitSymbol(game.trump)}
                        {game.makerSeat && (
                          <span style={{ marginLeft: 8, color: "#555" }}>
                            (maker: {displayMakerSeat ?? game.makerSeat})
                          </span>
                          )}
                      </div>
                      )}
                  </div>

          {/* Bidding UI (Round 1) */}
                  {game.phase === "bidding_round_1" && (
                    <div style={{ ...cardStyle, marginTop: 12 }}>
                      <h4 style={{ marginTop: 0 }}>Bidding (Round 1)</h4>

                      <div style={{ marginBottom: 8 }}>
                        <b>Current turn:</b> {displayTurn ?? game.turn}
                        {displayPasses.length > 0 && (
                          <span style={{ marginLeft: 10, color: "#555" }}>
                            (passed: {displayPasses.join(", ")})
                          </span>
                          )}
                      </div>

                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          onClick={bidOrderUp}
                          disabled={!mySeat || mySeat !== game.turn}
                          style={{ ...btnStyle, flex: 1 }}
                        >
                          Order Up
                        </button>
                        <button
                          onClick={bidPassRound1}
                          disabled={!mySeat || mySeat !== game.turn}
                          style={{ ...btnStyle, flex: 1 }}
                        >
                          Pass
                        </button>
                      </div>
                    </div>
                    )}

          {/* Bidding UI (Round 2) — Screw the dealer */}
                  {game.phase === "bidding_round_2" && (
                    <div style={{ ...cardStyle, marginTop: 12 }}>
                      <h4 style={{ marginTop: 0 }}>Bidding (Round 2)</h4>

                      <div style={{ marginBottom: 8 }}>
                        <b>Current turn:</b> {displayTurn ?? game.turn}
                        {isDealerStuck ? (
                          <span style={{ marginLeft: 8, color: "#b00" }}>
                            ({displayDealer ?? game.dealer} dealer must choose)
                          </span>
                          ) : null}

                        {displayPasses.length > 0 && (
                          <div style={{ marginTop: 6, color: "#555", fontSize: 13 }}>
                            Passed: {displayPasses.join(", ")}
                          </div>
                          )}
                      </div>

                      <div style={{ marginBottom: 10, color: "#555" }}>
                        Choose trump (cannot be the upcard suit
                          {upcardSuit ? ` ${suitSymbol(upcardSuit)}` : ""}).
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                        {round2AllowedSuits.map((suit) => (
                          <button
                            key={suit}
                            onClick={() => bidCallTrump(suit)}
                            disabled={!mySeat || mySeat !== game.turn}
                            style={{ ...btnStyle, padding: "12px 10px" }}
                          >
                            {suitSymbol(suit)}
                          </button>
                          ))}
                      </div>

              {/* Only show Pass if it is NOT the forced dealer turn */}
                      {!isDealerStuck && (
                        <button
                          onClick={bidPassRound2}
                          disabled={!mySeat || mySeat !== game.turn}
                          style={{ ...btnStyle, width: "100%", marginTop: 10 }}
                        >
                          Pass
                        </button>
                        )}

                      {isDealerStuck && (
                        <div style={{ marginTop: 10, fontSize: 13, color: "#b00" }}>
                          Screw the dealer: you can’t pass here.
                        </div>
                        )}
                    </div>
                    )}

          {/* Dealer discard */}
                  {game.phase === "dealer_discard" && (
                    <div style={{ ...cardStyle, marginTop: 12 }}>
                      <h4 style={{ marginTop: 0 }}>Dealer: Pick up & Discard</h4>

                      <div style={{ marginBottom: 8 }}>
                        <b>Trump:</b> {game.trump ? suitSymbol(game.trump) : "(unknown)"}
                      </div>

                      {mySeat === game.dealer ? (
                        <>
                        <div style={{ marginBottom: 10, color: "#555" }}>
                          You must pick up the upcard and discard one card (you may discard the upcard).
                        </div>

                  {/* Upcard display */}
                        <div style={{ marginBottom: 10 }}>
                          <b>Upcard:</b>
                          <div style={{ marginTop: 8 }}>
                            {(() => {
                              const { rank, suit } = parseCard(game.upcard as CardCode);
                              return (
                                <Card
                                  rank={rankLabel(rank)}
                                  suit={suitSymbol(suit)}
                                  selected={false}
                                  onClick={() => {}}
                                  />
                                  );
                            })()}
                          </div>
                        </div>

                  {/* Discard controls */}
                        <button
                          onClick={() => dealerPickupAndDiscard(game.upcard as CardCode)}
                          style={{ ...btnStyle, width: "100%", marginBottom: 8 }}
                        >
                          Discard Upcard
                        </button>

                        <button
                          onClick={() => {
                            if (selectedCard == null) {
                              setErr("Select a card from your hand to discard.");
                              return;
                            }
                            dealerPickupAndDiscard(myHand[selectedCard]);
                          }}
                          style={{ ...btnStyle, width: "100%" }}
                        >
                          Discard Selected Card
                        </button>

                        <div style={{ marginTop: 8, fontSize: 13, color: "#555" }}>
                          Tip: tap a card in your hand to select it.
                        </div>
                        </>
                        ) : (
                        <div style={{ color: "#555" }}>
                          Waiting for dealer ({displayDealer ?? game.dealer}) to pick up and discard…
                        </div>
                        )}
                      </div>
                      )}

          {/* Seat selection / lobby */}
                  <h4>Seats</h4>

                  <div style={tableStyle}>
            {/* Top (North) */}
                    <div style={{ gridColumn: "2 / 3", gridRow: "1 / 2" }}>
                      <SeatCard
                        seat="N"
                        label={seatLabel(displaySeats.N)}
                        isYou={mySeat === displaySeats.N}
                        disabled={!uid || !!game?.seats[displaySeats.N] || !!mySeat}
                        onClaim={() => claimSeat(displaySeats.N)}
                      />
                    </div>

            {/* Left (West) */}
                    <div style={{ gridColumn: "1 / 2", gridRow: "2 / 3" }}>
                      <SeatCard
                        seat="W"
                        label={seatLabel(displaySeats.W)}
                        isYou={mySeat === displaySeats.W}
                        disabled={!uid || !!game?.seats[displaySeats.W] || !!mySeat}
                        onClaim={() => claimSeat(displaySeats.W)}
                      />
                    </div>

            {/* Right (East) */}
                    <div style={{ gridColumn: "3 / 4", gridRow: "2 / 3" }}>
                      <SeatCard
                        seat="E"
                        label={seatLabel(displaySeats.E)}
                        isYou={mySeat === displaySeats.E}
                        disabled={!uid || !!game?.seats[displaySeats.E] || !!mySeat}
                        onClaim={() => claimSeat(displaySeats.E)}
                      />
                    </div>

            {/* Bottom (South) */}
                    <div style={{ gridColumn: "2 / 3", gridRow: "3 / 4" }}>
                      <SeatCard
                        seat="S"
                        label={seatLabel(displaySeats.S)}
                        isYou={mySeat === displaySeats.S}
                        disabled={!uid || !!game?.seats[displaySeats.S] || !!mySeat}
                        onClaim={() => claimSeat(displaySeats.S)}
                      />
                    </div>
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

function SeatCard(props: {
  seat: Seat;
  label: string;
  isYou: boolean;
  disabled: boolean;
  onClaim: () => void;
}) {
  const { seat, label, isYou, disabled, onClaim } = props;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <b>{seat}</b>
        {isYou && <span style={{ fontSize: 12, color: "#0a7" }}>You</span>}
        </div>

        <div style={{ marginTop: 8, color: "#555" }}>{label}</div>

        <button
          onClick={onClaim}
          disabled={disabled}
          style={{ ...btnStyle, marginTop: 10, width: "100%" }}
        >
          Claim
        </button>
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

const tableStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gridTemplateRows: "auto auto auto",
  gap: 10,
  alignItems: "stretch",
};