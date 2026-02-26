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

  upcard?: CardCode | null;
  kitty?: CardCode[] | null;
  trump?: Suit | null;
  makerSeat?: Seat | null;

  bidding?: {
    round: 1 | 2;
    passes: Seat[];
    orderedUpBy: Seat | null;
  } | null;

  currentTrick?: {
    trickNumber: number; // 1..5
    leadSeat: Seat;
    leadSuit: Suit | null; // effective suit
    cards: Partial<Record<Seat, CardCode>>; // REAL seat -> card
  } | null;

  tricksTaken?: { NS: number; EW: number } | null;
  trickWinners?: Seat[] | null;
};

type PlayerDoc = {
  uid: string;
  name?: string;
  seat?: Seat;
  joinedAt?: any;
  hand?: CardCode[];
};

/**
 * Team display:
 * - Data is always tracked as NS vs EW (real seats)
 * - UI can show per-viewer Team A (you + partner) and Team B (opponents)
 */
type TeamKey = "NS" | "EW";

function teamKeyForSeat(seat: Seat): TeamKey {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

function otherTeam(team: TeamKey): TeamKey {
  return team === "NS" ? "EW" : "NS";
}

function winningTeam(score: { NS: number; EW: number }, target = 10): TeamKey | null {
  if (score.NS >= target) return "NS";
  if (score.EW >= target) return "EW";
  return null;
}

function TrickMeter(props: {
  aLabel: string;
  aCount: number;
  bLabel: string;
  bCount: number;
}) {
  const { aLabel, aCount, bLabel, bCount } = props;

  const DotRow = ({ filled }: { filled: number }) => (
    <div style={{ display: "flex", gap: 6 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 12,
            height: 12,
            borderRadius: 999,
            border: "1px solid #bbb",
            background: i < filled ? "#111" : "transparent",
          }}
          />
          ))}
    </div>
    );

  return (
    <div style={{ ...cardStyle, marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>Tricks This Hand</div>

      <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 28px", gap: 10, rowGap: 10 }}>
        <div style={{ fontWeight: 700 }}>{aLabel}</div>
        <DotRow filled={aCount} />
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{aCount}</div>

        <div style={{ fontWeight: 700 }}>{bLabel}</div>
        <DotRow filled={bCount} />
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{bCount}</div>
      </div>
    </div>
    );
}

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
 * - Firestore stores REAL seats (N/E/S/W)
 * - UI shows DISPLAY seats rotated so viewer is always South
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

function teamOf(seat: Seat): "NS" | "EW" {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

/**
 * Euchre helpers (minimum correct set)
 */
function leftBowerSuit(trump: Suit): Suit {
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
  if (isJack(code) && s === leftBowerSuit(trump)) return trump; // left bower is trump
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

  // Following lead suit competes
  if (eff === leadSuit) return 100 + rank;

  // Off-suit loses
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
    const score = trickStrength(c, leadSuit, trump);
    if (score > bestScore) {
      bestScore = score;
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

  const teamUi = useMemo(() => {
    // Internally we track NS vs EW (real seats). Keep Team A/B consistent for ALL players:
    //   Team A = NS (North/South)
    //   Team B = EW (East/West)
    // Your *personal* team is derived from your REAL seat, but the labels do not flip per viewer.
    const aTeam: TeamKey = "NS";
    const bTeam: TeamKey = "EW";

    const labelForTeam: Record<TeamKey, string> = {
      NS: "Team A",
      EW: "Team B",
    };

    const myTeam: TeamKey | null = mySeat ? teamKeyForSeat(mySeat) : null;

    return { aTeam, bTeam, labelForTeam, myTeam };
  }, [mySeat]);


  const url = typeof window !== "undefined" ? window.location.href : "";

  const upcardSuit: Suit | null = game?.upcard ? suitCharFromCard(game.upcard) : null;
  const round2AllowedSuits: Suit[] = upcardSuit ? SUITS.filter((s) => s !== upcardSuit) : SUITS;

  const isDealerStuck: boolean =
  !!game &&
  game.phase === "bidding_round_2" &&
  game.bidding?.round === 2 &&
  (game.bidding?.passes?.length ?? 0) === 3 &&
  game.turn === game.dealer;

  /**
   * Dealer pickup/discard visual:
   * During dealer_discard, the dealer temporarily sees a 6-card hand (their 5 + upcard).
   * Everyone else just sees their normal hand.
   */
  const displayHand: CardCode[] = useMemo(() => {
    if (game?.phase === "dealer_discard" && mySeat === game.dealer && game.upcard) {
      return [...myHand, game.upcard];
    }
    return myHand;
  }, [game?.phase, game?.dealer, game?.upcard, mySeat, myHand]);

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

  // Map DISPLAY -> REAL for seat cards
  const displaySeats: Record<Seat, Seat> = useMemo(() => {
    if (!mySeat) return { N: "N", E: "E", S: "S", W: "W" };

    const m: Record<Seat, Seat> = { N: "N", E: "E", S: "S", W: "W" };
    (SEATS as Seat[]).forEach((real) => {
      const disp = realToDisplaySeat(real, mySeat);
      m[disp] = real;
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

  const playableInfo = useMemo(() => {
  // Default: everything clickable unless it’s your playing turn.
    if (!game || game.phase !== "playing" || !isMyTurn || !mySeat || !game.trump) {
      return { mustFollow: null as Suit | null, playableSet: null as Set<CardCode> | null };
    }

    const trump = game.trump;
    const trick = game.currentTrick;
    const cards = trick?.cards ?? {};
    const trickStarted = Object.keys(cards).length > 0;
    const leadSuit = trickStarted ? (trick?.leadSuit ?? null) : null;

  // If you’re leading (no lead suit yet), you can play anything.
    if (!leadSuit) {
      return { mustFollow: null, playableSet: null };
    }

    const mustFollow = hasSuitInHand(myHand, leadSuit, trump) ? leadSuit : null;

  // If you must follow, only those cards are legal. Otherwise all are legal.
    if (!mustFollow) {
      return { mustFollow: null, playableSet: null };
    }

    const playable = new Set<CardCode>();
    myHand.forEach((c) => {
      if (effectiveSuit(c, trump) === mustFollow) playable.add(c);
    });

    return { mustFollow, playableSet: playable };
  }, [game, isMyTurn, mySeat, myHand]);

    const renderSeat = (displayPos: Seat, gridColumn: string, gridRow: string) => {
      const realSeat = displaySeats[displayPos];

      return (
        <div style={{ gridColumn, gridRow }}>
          <SeatCard
            seat={displayPos} // DISPLAY position for alignment rules
            label={seatLabel(realSeat)} // label from REAL seat
            isYou={mySeat === realSeat}
            isTurn={game.turn === realSeat}
            teamLabel={teamUi.labelForTeam[teamKeyForSeat(realSeat)]}
            canClaim={!!uid && !game.seats[realSeat] && !mySeat}
            playedCard={
              game.phase === "playing" ? (game.currentTrick?.cards?.[realSeat] ?? null) : null
            }
            onClaim={() => claimSeat(realSeat)}
          />
        </div>
      );
    };

  /**
   * ==========================================================
   * Effects
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

  async function startHand() {
    if (!gameId || !uid || !gameRef || !game) return;

    const allFilled = (SEATS as Seat[]).every((seat) => !!game.seats[seat]);
    if (!allFilled) {
      setErr("Need all 4 seats filled to start a hand.");
      return;
    }

    const score = g.score ?? { NS: 0, EW: 0 };
const winner = winningTeam(score, 10);

if (g.status === "finished" || winner) {
  setErr(`Game over — ${winner ? (winner === "NS" ? "Team A" : "Team B") : "a team"} reached 10.`);
  return;
}

    const dealer: Seat = game.dealer ? nextSeat(game.dealer) : "N";
    const firstToAct: Seat = nextSeat(dealer);

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

      // reset per-hand trick state
      currentTrick: null,
      tricksTaken: { NS: 0, EW: 0 },
      trickWinners: [],

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
        turn: g.dealer, // dealer must pick up + discard
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
        turn: nextSeat(g.dealer), // first lead left of dealer
      });
    });
  }

  async function dealerPickupAndDiscard(discard: CardCode) {
    if (!gameRef || !gameId || !game || !uid || !mySeat) return;

    if (game.phase !== "dealer_discard") return;
    if (mySeat !== game.dealer) return;
    if (game.turn !== game.dealer) return;
    if (!game.upcard) return;

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

        const combined: CardCode[] = [...hand, g.upcard];

        const discardIdx = combined.indexOf(discard);
        if (discardIdx === -1) throw new Error("Discard card not found");

        const nextHand = combined.slice();
        nextHand.splice(discardIdx, 1);
        if (nextHand.length !== 5) throw new Error("Resulting hand not 5 cards");

        const nextKitty = [...(g.kitty ?? []), discard];

        tx.update(dealerRef2, { hand: nextHand, updatedAt: serverTimestamp() });

        tx.update(gameRef, {
          status: "playing",
          phase: "playing",
          kitty: nextKitty,
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

        const trick = g.currentTrick ?? null;
        const existingCards = trick?.cards ?? {};
        if (existingCards[mySeat]) throw new Error("You already played this trick");

        const isNewTrick = !trick || Object.keys(existingCards).length === 0;

        const leadSeat: Seat = isNewTrick ? mySeat : (trick!.leadSeat as Seat);
        const leadSuit: Suit = isNewTrick
        ? effectiveSuit(code, trump)
        : (trick!.leadSuit as Suit);

        // Follow-suit enforcement (only if not leading)
        if (!isNewTrick) {
          const mustFollow = hasSuitInHand(hand, leadSuit, trump);
          if (mustFollow) {
            const eff = effectiveSuit(code, trump);
            if (eff !== leadSuit) throw new Error("Must follow suit");
          }
        }

        const nextHand = removeOneCard(hand, code);

        const nextCards: Partial<Record<Seat, CardCode>> = {
          ...existingCards,
          [mySeat]: code,
        };

        const currentTrickNumber = trick?.trickNumber ?? 1;
        const seatsPlayed = Object.keys(nextCards).length;

        // If trick completes, determine winner and start next trick / end hand
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

          tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });

// End of hand after 5 tricks → award points, then reset to lobby
if (currentTrickNumber >= 5) {
  const makerSeat = g.makerSeat as Seat | null;
  const makerTeam: TeamKey | null = makerSeat ? teamKeyForSeat(makerSeat) : null;
  const defenseTeam: TeamKey | null = makerTeam ? otherTeam(makerTeam) : null;

  // Default to existing score (schema already has it)
  const prevScore = g.score ?? { NS: 0, EW: 0 };
  const nextScore = { ...prevScore };

  if (makerTeam && defenseTeam) {
    const makerTricks = nextTaken[makerTeam];

    if (makerTricks >= 5) {
      nextScore[makerTeam] += 2;
    } else if (makerTricks >= 3) {
      nextScore[makerTeam] += 1;
    } else {
      // Euchred
      nextScore[defenseTeam] += 2;
    }
  }

  const winner = winningTeam(nextScore, 10);

tx.update(gameRef, {
  updatedAt: serverTimestamp(),
  tricksTaken: nextTaken,
  trickWinners: nextWinners,
  score: nextScore,

  // ✅ win condition
  status: winner ? "finished" : "lobby",
  winnerTeam: winner, // NEW FIELD (additive)

  // reset per-hand state (keep your current behavior)
  phase: "lobby",
  currentTrick: null,
  upcard: null,
  kitty: null,
  trump: null,
  makerSeat: null,
  bidding: null,
});
return;
}

          // Next trick (winner leads)
          tx.update(gameRef, {
            updatedAt: serverTimestamp(),
            tricksTaken: nextTaken,
            trickWinners: nextWinners,
            currentTrick: {
              trickNumber: currentTrickNumber + 1,
              leadSeat: winner,
              leadSuit: null,
              cards: {},
            },
            turn: winner,
          });

          return;
        }

        // Trick not complete yet → next seat (simple clockwise; skips not-yet logic later if needed)
        tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });

        tx.update(gameRef, {
          updatedAt: serverTimestamp(),
          currentTrick: {
            trickNumber: currentTrickNumber,
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

      {/* Host-only for now: N starts the hand */}
        <button
          onClick={startHand}
          disabled={game?.status === "finished"}
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
                      <b>Dealer:</b> {displayDealer ?? game.dealer}
                    </div>
                    <div>
                      <b>Turn:</b> {displayTurn ?? game.turn}
                    </div>
                    <div>
                      <b>Score:</b> {teamUi.labelForTeam[teamUi.aTeam]} {game.score[teamUi.aTeam]} — {teamUi.labelForTeam[teamUi.bTeam]} {game.score[teamUi.bTeam]}
                    </div>

                    {teamUi.myTeam && (
                      <div>
                        <b>Your Team:</b> {teamUi.labelForTeam[teamUi.myTeam]}
                      </div>
                      )}

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

                    {(game.phase === "playing" || game.phase === "dealer_discard") && game.trump && (
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

          {/* Tricks tracker (Team A = NS, Team B = EW) */}
                  {game.phase === "playing" && (
                    <TrickMeter
                      aLabel={teamUi.labelForTeam[teamUi.aTeam]}
                      aCount={game.tricksTaken?.[teamUi.aTeam] ?? 0}
                      bLabel={teamUi.labelForTeam[teamUi.bTeam]}
                      bCount={game.tricksTaken?.[teamUi.bTeam] ?? 0}
                      />
                      )}

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
                          Select a card to discard.
                        </div>

                        <button
                          onClick={() => {
                            if (selectedCard == null) {
                              setErr("Select a card to discard.");
                              return;
                            }
                            const code = displayHand[selectedCard];
                            if (!code) {
                              setErr("Select a card to discard.");
                              return;
                            }
                            dealerPickupAndDiscard(code);
                          }}
                          style={{ ...btnStyle, width: "100%" }}
                        >
                          Discard Selected Card
                        </button>
                        </>
                        ) : (
                        <div style={{ color: "#555" }}>
                          Waiting for dealer ({displayDealer ?? game.dealer}) to pick up and discard…
                        </div>
                        )}
                      </div>
                      )}

          {/* Seats */}

                <div style={tableStyle}>
                  {renderSeat("N", "2 / 3", "1 / 2")}
                  {renderSeat("W", "1 / 2", "2 / 3")}
                  {renderSeat("E", "3 / 4", "2 / 3")}
                  {renderSeat("S", "2 / 3", "3 / 4")}
                </div>

          {/* My private hand */}
                  <h4 style={{ marginTop: 24 }}>Your Hand</h4>
                  <div
  style={{
    display: "flex",
    gap: 10,
    overflowX: "auto",
    overflowY: "visible",   // 👈 key line
    paddingTop: 10,         // 👈 gives room for the lift
    paddingBottom: 8,
  }}
>
                    {displayHand.map((code, i) => {
                      const { rank, suit } = parseCard(code);

                      const isPlayingTurn = game?.phase === "playing" && isMyTurn;
                      const mustFollow = playableInfo.mustFollow;
                      const playableSet = playableInfo.playableSet;
                      const isPlayable =
                      !isPlayingTurn || !playableSet ? true : playableSet.has(code);

                      return (
                        <div
                          key={code + i}
                          style={{
                            opacity: isPlayable ? 1 : 0.35,
                            pointerEvents: isPlayable ? "auto" : "none",
                            transition: "opacity 120ms ease",
                          }}
                          title={!isPlayable && mustFollow ? `Must follow ${mustFollow}` : undefined}
                        >
                          <Card
                            rank={rankLabel(rank)}
                            suit={suitSymbol(suit)}
                            selected={selectedCard === i}
                            onClick={() => {
          // Dealer discard: still uses selection
                              if (game?.phase === "dealer_discard") {
                                setSelectedCard(selectedCard === i ? null : i);
                                return;
                              }

          // Playing: click plays immediately
                              if (game?.phase === "playing" && isMyTurn) {
                                playCard(code);
                                return;
                              }

          // Other phases: selection only
                              setSelectedCard(selectedCard === i ? null : i);
                            }}
                          />
                        </div>
                        );
                    })}
                  </div>
                  </>
                  )}
</div>
);
}

function SeatCard(props: {
  seat: Seat; // DISPLAY seat label
  label: string;
  isYou: boolean;
  isTurn: boolean;
  teamLabel?: string;
  canClaim: boolean;
  playedCard?: CardCode | null;
  onClaim: () => void;
}) {
  const { seat, label, isYou, isTurn, teamLabel, canClaim, playedCard, onClaim } = props;

  // E: card left of text | W: card right of text | N: card below text | S: card above text
  const layout =
    seat === "E"
      ? { dir: "row" as const, textAlign: "left" as const, textItems: "flex-start" as const }
      : seat === "W"
      ? { dir: "row-reverse" as const, textAlign: "right" as const, textItems: "flex-end" as const }
      : seat === "N"
      ? { dir: "column-reverse" as const, textAlign: "center" as const, textItems: "center" as const } // card below
      : { dir: "column" as const, textAlign: "center" as const, textItems: "center" as const }; // S card above

  const teamIsA = teamLabel === "Team A";

  return (
    <div
      style={{
        ...cardStyle,
        borderColor: isTurn ? "#0a7" : "#ddd",
        boxShadow: isTurn ? "0 0 0 2px rgba(0,170,119,0.15)" : undefined,
        display: "flex",
        flexDirection: "column",
        paddingTop: 6,
        paddingBottom: 10,
        minHeight: 130, // smaller than before, keeps boxes consistent
      }}
    >

      {/* Main content */}
      <div
        style={{
          display: "flex",
          flexDirection: layout.dir,
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          flex: "1 1 auto",
        }}
      >
        {/* Played card */}
        {playedCard ? (
          <div style={{ flex: "0 0 auto" }}>
            {(() => {
              const { rank, suit } = parseCard(playedCard);
              return (
                <div style={{ transform: "scale(0.92)", transformOrigin: "center" }}>
                  <Card
                    rank={rankLabel(rank)}
                    suit={suitSymbol(suit)}
                    selected={false}
                    onClick={() => {}}
                  />
                </div>
              );
            })()}
          </div>
        ) : null}

        {/* Name + Team */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: layout.textItems,
            textAlign: layout.textAlign,
            minWidth: 0,
          }}
        >
          <div style={{ color: "#555", fontSize: 18, lineHeight: 1.15 }}>{label}</div>

          {teamLabel ? (
            <div style={{ marginTop: 6 }}>
              <span
                style={{
                  fontSize: 12,
                  padding: "3px 8px",
                  borderRadius: 8, // tag, not pill
                  border: "1px solid #d9d9d9",
                  display: "inline-block",
                  whiteSpace: "nowrap", // prevents "Team" / "A" stacking
                  lineHeight: 1.2,
                  background: teamIsA ? "rgba(66, 133, 244, 0.10)" : "rgba(15, 157, 88, 0.10)",
                  color: teamIsA ? "#2b5fb8" : "#0a7a46",
                }}
              >
                {teamLabel}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {canClaim ? (
        <button onClick={onClaim} style={{ ...btnStyle, marginTop: 10, width: "100%" }}>
          Claim
        </button>
      ) : null}
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
  marginBottom: 12,
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
  justifyItems: "stretch",
};