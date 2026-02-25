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
  status: string;
  phase?: GamePhase;

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

  currentTrick?: {
    trickNumber: number;
    leadSeat: Seat;
    leadSuit: Suit | null;
    cards: Partial<Record<Seat, CardCode>>;
  };

tricksTaken?: { NS: number; EW: number };  // per hand
trickWinners?: Seat[];                      // length up to 5 (real seats)
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
 * - DB stores REAL seats (N/E/S/W) consistently
 * - UI shows DISPLAY seats so viewer's seat is always South
 */
function seatIndex(seat: Seat): number {
  return SEATS.indexOf(seat);
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

function teamOf(seat: Seat): "NS" | "EW" {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

type Rank = ReturnType<typeof parseCard>["rank"];

function sameColor(a: Suit, b: Suit) {
  const red = (s: Suit) => s === "H" || s === "D";
  return red(a) === red(b);
}

function leftBowerSuit(trump: Suit): Suit {
  // trump H -> left bower is JD (D)
  // trump D -> JH (H)
  // trump S -> JC (C)
  // trump C -> JS (S)
  if (trump === "H") return "D";
  if (trump === "D") return "H";
  if (trump === "S") return "C";
  return "S";
}

function isJack(code: CardCode) {
  const { rank } = parseCard(code);
  return rankLabel(rank) === "J";
}

function effectiveSuit(code: CardCode, trump: Suit): Suit {
  const s = suitCharFromCard(code);
  // left bower becomes trump suit
  if (isJack(code) && s === leftBowerSuit(trump)) return trump;
  return s;
}

function isRightBower(code: CardCode, trump: Suit): boolean {
  return isJack(code) && suitCharFromCard(code) === trump;
}

function isLeftBower(code: CardCode, trump: Suit): boolean {
  return isJack(code) && suitCharFromCard(code) === leftBowerSuit(trump);
}

function hasSuitInHand(hand: CardCode[], suit: Suit, trump: Suit): boolean {
  return hand.some((c) => effectiveSuit(c, trump) === suit);
}

function removeOneCard(hand: CardCode[], code: CardCode): CardCode[] {
  const idx = hand.indexOf(code);
  if (idx === -1) return hand;
  const next = hand.slice();
  next.splice(idx, 1);
  return next;
}

function trickStrength(code: CardCode, leadSuit: Suit, trump: Suit): number {
  // Higher number = stronger
  if (isRightBower(code, trump)) return 200;
  if (isLeftBower(code, trump)) return 199;

  const eff = effectiveSuit(code, trump);
  const { rank } = parseCard(code);

  // Trump beats everything else
  if (eff === trump) return 150 + rank;

  // Must follow lead suit to compete
  if (eff === leadSuit) return 100 + rank;

  // Off-suit non-trump loses
  return 0 + rank;
}

function winnerOfTrick(
  cards: Partial<Record<Seat, CardCode>>,
  leadSeat: Seat,
  trump: Suit,
  leadSuit: Suit
  ): Seat {
  let bestSeat = leadSeat;
  let bestScore = -1;

  (Object.keys(cards) as Seat[]).forEach((seat) => {
    const c = cards[seat];
    if (!c) return;
    const s = trickStrength(c, leadSuit, trump);
    if (s > bestScore) {
      bestScore = s;
      bestSeat = seat;
    }
  });

  return bestSeat;
}

/**
 * ==========================================================
 * Game Screen
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

  const displayDealer: Seat | null = game?.dealer ? displaySeat(game.dealer) : null;
  const displayTurn: Seat | null = game?.turn ? displaySeat(game.turn) : null;
  const displayMakerSeat: Seat | null = game?.makerSeat ? displaySeat(game.makerSeat) : null;

  const displayPasses: Seat[] = (game?.bidding?.passes ?? []).map((s) => displaySeat(s as Seat));

  // displaySeats[DISPLAY] = REAL, for claim buttons
  const displaySeats: Record<Seat, Seat> = useMemo(() => {
    if (!mySeat) return { N: "N", E: "E", S: "S", W: "W" };

    const m: Record<Seat, Seat> = { N: "N", E: "E", S: "S", W: "W" };
    (SEATS as Seat[]).forEach((real) => {
      const display = realToDisplaySeat(real, mySeat);
      m[display] = real;
    });
    return m;
  }, [mySeat]);

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
   * ==========================================================
   */

  // 1) Anonymous auth
  useEffect(() => {
    ensureAnonAuth()
    .then((u) => setUid(u.uid))
    .catch((e) => setErr(String(e)));
  }, []);

  // 2) Game doc subscription
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

  // 3) Players subscription
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

  // 4) My player doc subscription (private hand)
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

  /** Claim a seat */
  async function claimSeat(seat: Seat) {
    if (!gameRef || !uid || !gameId) return;

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(gameRef);
        if (!snap.exists()) throw new Error("Game missing");

        const data = snap.data() as GameDoc;

        if (data.seats[seat]) throw new Error("Seat already taken");
        if (Object.values(data.seats).includes(uid))
          throw new Error("You already claimed a seat");

        tx.update(gameRef, {
          [`seats.${seat}`]: uid,
          updatedAt: serverTimestamp(),
        });
      });

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

  /** Deal a new hand and start bidding round 1. */
  async function startHand() {
    if (!gameId || !uid || !gameRef || !game) return;

    const allFilled = (SEATS as Seat[]).every((seat) => !!game.seats[seat]);
    if (!allFilled) {
      setErr("Need all 4 seats filled to start a hand.");
      return;
    }

    const dealer: Seat = game.dealer ? nextSeat(game.dealer) : "N";
    const firstToAct: Seat = nextSeat(dealer);

    const deck = shuffle(createEuchreDeck());

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

  /** Round 1: order up => go to dealer_discard */
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

      // dealer must act now
        turn: g.dealer,
      });
    });
  }

  async function bidPassRound2() {
    if (!gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_2") return;
    if (game.turn !== mySeat) return;

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
      if (mySeat === g.dealer) return;

      const passes = g.bidding?.passes ?? [];
      const nextPasses = passes.includes(mySeat) ? passes : [...passes, mySeat];

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
        status: "playing",
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

  /** Dealer picks up upcard and discards 1 (stays private on player doc). */
  async function dealerPickupAndDiscard(discard: CardCode) {
    if (!gameRef || !gameId || !game || !uid || !mySeat) return;

    if (game.phase !== "dealer_discard") return;
    if (mySeat !== game.dealer) return;
    if (game.turn !== game.dealer) return;
    if (!game.upcard) return;

    const dealerUid = game.seats[game.dealer];
    if (!dealerUid) return;

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

        const dealerRef = doc(db, "games", gameId, "players", dealerUid2);
        const playerSnap = await tx.get(dealerRef);
        if (!playerSnap.exists()) throw new Error("Dealer player doc missing");

        const p = playerSnap.data() as PlayerDoc;
        const hand = (p.hand ?? []) as CardCode[];
        if (hand.length !== 5) throw new Error("Dealer hand not 5 cards");

        const combined: CardCode[] = [...hand, g.upcard];
        const discardIdx = combined.indexOf(discard);
        if (discardIdx === -1) throw new Error("Discard card not found");

        const nextHand = combined.slice();
        nextHand.splice(discardIdx, 1);

        if (nextHand.length !== 5) throw new Error("Resulting hand not 5 cards");

        const nextKitty = [...(g.kitty ?? []), discard];

        tx.update(dealerRef, { hand: nextHand, updatedAt: serverTimestamp() });

        tx.update(gameRef, {
          status: "playing",
          phase: "playing",
          kitty: nextKitty,
          updatedAt: serverTimestamp(),
          turn: nextSeat(g.dealer),
        });
      });

      setErr(null);
      setSelectedCard(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  async function playCard(code: CardCode) {
    if (!gameRef || !gameId || !game || !uid || !mySeat) return;
    if (game.phase !== "playing") return;

    try {
      await runTransaction(db, async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists()) throw new Error("Game missing");
        const g = gameSnap.data() as GameDoc;

        if (g.phase !== "playing") return;
        if (g.turn !== mySeat) return;
        if (!g.trump) throw new Error("Trump not set");

        const trump = g.trump;

        const playerRef = doc(db, "games", gameId, "players", uid);
        const playerSnap = await tx.get(playerRef);
        if (!playerSnap.exists()) throw new Error("Player doc missing");

        const p = playerSnap.data() as PlayerDoc;
        const hand = (p.hand ?? []) as CardCode[];

        if (!hand.includes(code)) throw new Error("Card not in hand");

        const trick = g.currentTrick;
        const existingCards = trick?.cards ?? {};
        if (existingCards[mySeat]) throw new Error("You already played this trick");

        const isNewTrick = !trick || Object.keys(existingCards).length === 0;

        const leadSeat: Seat = isNewTrick ? mySeat : (trick!.leadSeat as Seat);
        const leadSuit: Suit = isNewTrick
        ? effectiveSuit(code, trump)
        : (trick!.leadSuit as Suit); // should be non-null once trick started

      // Follow-suit enforcement (only if not leading)
        if (!isNewTrick) {
          const mustFollow = hasSuitInHand(hand, leadSuit, trump);
          if (mustFollow) {
            const eff = effectiveSuit(code, trump);
            if (eff !== leadSuit) {
              throw new Error("Must follow suit");
            }
          }
        }

      // Remove card from hand
        const nextHand = removeOneCard(hand, code);

      // Add card to trick
        const nextCards: Partial<Record<Seat, CardCode>> = {
          ...existingCards,
          [mySeat]: code,
        };

        const nextTrickNumber = trick?.trickNumber ?? 1;

      // If trick completes (4 cards), score it and start next trick / end hand
        const seatsPlayed = Object.keys(nextCards).length;

        if (seatsPlayed === 4) {
          const winner = winnerOfTrick(nextCards, leadSeat, trump, leadSuit);

          const prevTaken = g.tricksTaken ?? { NS: 0, EW: 0 };
          const winTeam = teamOf(winner);

          const nextTaken = {
            NS: prevTaken.NS + (winTeam === "NS" ? 1 : 0),
            EW: prevTaken.EW + (winTeam === "EW" ? 1 : 0),
          };

          const prevWinners = (g.trickWinners ?? []) as Seat[];
          const nextWinners = [...prevWinners, winner];

        // End of hand after 5 tricks (no scoring to points yet)
          if (nextTrickNumber >= 5) {
            tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });

            tx.update(gameRef, {
              updatedAt: serverTimestamp(),

            // keep these for display / debugging
              tricksTaken: nextTaken,
              trickWinners: nextWinners,

            // clear trick
              currentTrick: null,

            // hand is over — you can decide later what this should become
              status: "lobby",
              phase: "lobby",

            // optional cleanup so the next deal is clean
              upcard: null,
              kitty: null,
              trump: null,
              makerSeat: null,
              bidding: null,
            });

            return;
          }

        // Start next trick (winner leads)
          tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });

          tx.update(gameRef, {
            updatedAt: serverTimestamp(),
            tricksTaken: nextTaken,
            trickWinners: nextWinners,
            currentTrick: {
              trickNumber: nextTrickNumber + 1,
              leadSeat: winner,
              leadSuit: null,
              cards: {},
            },
            turn: winner,
          });

          return;
        }

      // Trick not complete yet → advance to next seat
        tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });

        tx.update(gameRef, {
          updatedAt: serverTimestamp(),
          currentTrick: {
            trickNumber: nextTrickNumber,
            leadSeat,
            leadSuit,
            cards: nextCards,
          },
          turn: nextSeat(g.turn),
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

          {/* Public/shared summary */}
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

          {/* Bidding UI (Round 2) */}
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
                      Choose trump (cannot be the upcard suit{upcardSuit ? ` ${suitSymbol(upcardSuit)}` : ""}).
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
                        Tap a card to discard it (you can discard the upcard).
                      </div>

                      {(() => {
                        const up = game.upcard as CardCode | undefined;
                        const combined: CardCode[] = up ? [...myHand, up] : [...myHand];

                        return (
                          <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8 }}>
                            {combined.map((code, i) => {
                              const { rank, suit } = parseCard(code);

                          // If the upcard duplicates a card in hand (unlikely with a real deck),
                          // this keeps keys unique.
                              const key = `${code}-${i}`;

                              const isUpcard = up === code && i === combined.length - 1;

                              return (
                                <div key={key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                                  <Card
                                    rank={rankLabel(rank)}
                                    suit={suitSymbol(suit)}
                                    selected={false}
                                    onClick={() => dealerPickupAndDiscard(code)}
                                  />
                                  {isUpcard && (
                                    <div style={{ fontSize: 12, color: "#555" }}>
                                      Upcard
                                    </div>
                                    )}
                                </div>
                                );
                            })}
                          </div>
                          );
                      })()}

                      <div style={{ marginTop: 8, fontSize: 13, color: "#555" }}>
                        Discard happens immediately after you tap.
                      </div>
                      </>
                      ) : (
                      <div style={{ color: "#555" }}>
                        Waiting for dealer ({displayDealer ?? game.dealer}) to pick up and discard…
                      </div>
                      )}
                    </div>
                    )}

          {/* Seats */}
                <h4>Seats</h4>

                <div style={tableStyle}>
                  <div style={{ gridColumn: "2 / 3", gridRow: "1 / 2" }}>
                    <SeatCard
                      seat="N"
                      label={seatLabel(displaySeats.N)}
                      isYou={mySeat === displaySeats.N}
                      canClaim={!!uid && !game?.seats[displaySeats.N] && !mySeat}
                      onClaim={() => claimSeat(displaySeats.N)}
                    />
                  </div>

                  <div style={{ gridColumn: "1 / 2", gridRow: "2 / 3" }}>
                    <SeatCard
                      seat="W"
                      label={seatLabel(displaySeats.W)}
                      isYou={mySeat === displaySeats.W}
                      canClaim={!!uid && !game?.seats[displaySeats.W] && !mySeat}
                      onClaim={() => claimSeat(displaySeats.W)}
                    />
                  </div>

                  <div style={{ gridColumn: "3 / 4", gridRow: "2 / 3" }}>
                    <SeatCard
                      seat="E"
                      label={seatLabel(displaySeats.E)}
                      isYou={mySeat === displaySeats.E}
                      canClaim={!!uid && !game?.seats[displaySeats.E] && !mySeat}
                      onClaim={() => claimSeat(displaySeats.E)}
                    />
                  </div>

                  <div style={{ gridColumn: "2 / 3", gridRow: "3 / 4" }}>
                    <SeatCard
                      seat="S"
                      label={seatLabel(displaySeats.S)}
                      isYou={mySeat === displaySeats.S}
                      canClaim={!!uid && !game?.seats[displaySeats.S] && !mySeat}
                      onClaim={() => claimSeat(displaySeats.S)}
                    />
                  </div>
                </div>

                {game.phase === "playing" && (
                  <div style={{ ...cardStyle, marginTop: 12 }}>
                    <h4 style={{ marginTop: 0 }}>Current Trick</h4>

                    <div style={{ marginBottom: 8, color: "#555" }}>
                      Trick #{game.currentTrick?.trickNumber ?? 1}
                      {game.tricksTaken && (
                        <span style={{ marginLeft: 10 }}>
                          Taken: NS {game.tricksTaken.NS} — EW {game.tricksTaken.EW}
                        </span>
                        )}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                      {(SEATS as Seat[]).map((realSeat) => {
                        const played = game.currentTrick?.cards?.[realSeat];
                        const label = displaySeat(realSeat);

                        return (
                          <div key={realSeat} style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 12, color: "#555", marginBottom: 6 }}>{label}</div>
                            {played ? (
                              (() => {
                                const { rank, suit } = parseCard(played as CardCode);
                                return (
                                  <Card
                                    rank={rankLabel(rank)}
                                    suit={suitSymbol(suit)}
                                    selected={false}
                                    onClick={() => {}}
                                    />
                                    );
                              })()
                              ) : (
                              <div style={{ height: 64, border: "1px dashed #ccc", borderRadius: 12 }} />
                              )}
                            </div>
                            );
                      })}
                    </div>
                  </div>
                  )}

          {/* Hand */}
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
                        onClick={() => {
                          if (game?.phase === "dealer_discard") return;

                          if (game?.phase === "playing" && isMyTurn) {
                            playCard(code);
                            return;
                          }

                          setSelectedCard(selectedCard === i ? null : i);
                        }}
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
  canClaim: boolean;
  onClaim: () => void;
}) {
  const { seat, label, isYou, canClaim, onClaim } = props;

  return (
    <div style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <b>{seat}</b>
        {isYou && <span style={{ fontSize: 12, color: "#0a7" }}>You</span>}
        </div>

        <div style={{ marginTop: 8, color: "#555" }}>{label}</div>

        {canClaim && (
          <button
            onClick={onClaim}
            style={{ ...btnStyle, marginTop: 10, width: "100%" }}
          >
            Claim
          </button>
          )}
      </div>
      );
}

/**
 * ==========================================================
 * Styles
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