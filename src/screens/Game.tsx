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
import SeatCard from "../components/SeatCard";
import TrickMeter from "../components/TrickMeter";
import TrumpIndicator from "../components/TrumpIndicator";
import CardThemePicker from "../components/CardThemePicker";

import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import { createEuchreDeck, shuffle } from "../lib/deal";
import {
  teamKeyForSeat,
  teamOf,
  otherTeam,
  partnerOf,
  winningTeam,
  nextSeat,
  realToDisplaySeat,
  suitCharFromCard,
  effectiveSuit,
  hasSuitInHand,
  removeOneCard,
  winnerOfTrick,
} from "../lib/gameLogic";
import type { Seat, Suit, TeamKey, GameDoc, PlayerDoc } from "../types/game";
import { SEATS, SUITS } from "../types/game";

import "./game.css";

// =============================================================================
// Main Component — Game
// =============================================================================

export default function Game() {

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  const { gameId } = useParams();

  // ---------------------------------------------------------------------------
  // Local UI State
  // ---------------------------------------------------------------------------

  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [goAloneIntent, setGoAloneIntent] = useState(false);

  // Index into `displayHand` of the card the player has tapped/selected.
  // Used during dealer_discard (tap to select, then confirm) and as a
  // fallback selection state in other phases.
  const [selectedCard, setSelectedCard] = useState<number | null>(null);

  // Name gate: players must enter a display name before joining or acting.
  // `savedName` is the confirmed value (persisted in localStorage).
  // `nameDraft` tracks live input before the player clicks Continue.
  const [savedName, setSavedName] = useState<string>(() => (localStorage.getItem("playerName") || "").trim());
  const [nameDraft, setNameDraft] = useState<string>(() => (localStorage.getItem("playerName") || "").trim());

  const hasName = savedName.trim().length > 0;

  function saveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    localStorage.setItem("playerName", trimmed);
    setSavedName(trimmed);
    setNameDraft(trimmed);
    setErr(null);
  }

  // ---------------------------------------------------------------------------
  // Auth & Firestore State
  // ---------------------------------------------------------------------------

  const [uid, setUid] = useState<string | null>(null);
  const [game, setGame] = useState<GameDoc | null>(null);

  // All player docs in this game, keyed by uid (names, seats, etc.).
  const [players, setPlayers] = useState<Record<string, PlayerDoc>>({});

  // The local player's private hand (fetched from their own player doc).
  const [myHand, setMyHand] = useState<CardCode[]>([]);

  // ---------------------------------------------------------------------------
  // Firestore References
  // ---------------------------------------------------------------------------

  const gameRef = useMemo(() => (gameId ? doc(db, "games", gameId) : null), [gameId]);

  // ---------------------------------------------------------------------------
  // Derived Values — Real Seats
  // ---------------------------------------------------------------------------

  const scoreNS = game?.score?.NS ?? 0;
  const scoreEW = game?.score?.EW ?? 0;

  const winnerTeam = game?.winnerTeam ?? null;
  const winnerLabel =
    winnerTeam === "NS" ? "Team A" : winnerTeam === "EW" ? "Team B" : null;

  // The real seat occupied by the local player, or null if they haven't sat down.
  const mySeat: Seat | null =
    uid && game
      ? ((Object.entries(game.seats).find(([, v]) => v === uid)?.[0] as Seat | undefined) ?? null)
      : null;

  const isGameFinished = game?.status === "finished";

  // The local player can deal if they are seated at the dealer position and all seats are full.
  const canDeal =
    !!game &&
    !isGameFinished &&
    game.status === "lobby" &&
    (game.phase === "lobby" || !game.phase) &&
    hasName &&
    !!mySeat &&
    mySeat === (game.dealer ?? "N");

  const isMyTurn = !!uid && !!game && !!mySeat && game.turn === mySeat;

  // Team labels are consistent for all players: Team A = NS, Team B = EW.
  // `myTeam` is derived from the local player's real seat.
  const teamUi = useMemo(() => {
    const aTeam: TeamKey = "NS";
    const bTeam: TeamKey = "EW";
    const labelForTeam: Record<TeamKey, string> = { NS: "Team A", EW: "Team B" };
    const myTeam: TeamKey | null = mySeat ? teamKeyForSeat(mySeat) : null;
    return { aTeam, bTeam, labelForTeam, myTeam };
  }, [mySeat]);

  const url = typeof window !== "undefined" ? window.location.href : "";

  // The suit of the upcard, used to restrict trump choices in bidding round 2.
  const upcardSuit: Suit | null = game?.upcard ? suitCharFromCard(game.upcard) : null;
  const round2AllowedSuits: Suit[] = upcardSuit ? SUITS.filter((s) => s !== upcardSuit) : SUITS;

  // True when all three non-dealer players have passed in round 2, forcing the dealer to call trump.
  const isDealerStuck: boolean =
    !!game &&
    game.phase === "bidding_round_2" &&
    game.bidding?.round === 2 &&
    (game.bidding?.passes?.length ?? 0) === 3 &&
    game.turn === game.dealer;

  // True when the current hand is being played alone by the maker.
  const goingAlone = game?.goingAlone ?? false;
  const partnerSeatReal: Seat | null = (game?.partnerSeat as Seat | null) ?? null;

  // During dealer_discard, the dealer temporarily sees 6 cards (their 5 + the upcard).
  // All other players see only their normal 5-card hand.
  const displayHand: CardCode[] = useMemo(() => {
    if (game?.phase === "dealer_discard" && mySeat === game.dealer && game.upcard) {
      return [...myHand, game.upcard];
    }
    return myHand;
  }, [game?.phase, game?.dealer, game?.upcard, mySeat, myHand]);

  // ---------------------------------------------------------------------------
  // Derived Values — Display Seats
  // ---------------------------------------------------------------------------
  // These convert real seats to display seats for rendering only.

  const displaySeat = (real: Seat): Seat => {
    if (!mySeat) return real;
    return realToDisplaySeat(real, mySeat);
  };

  const displayDealer: Seat | null = game?.dealer ? displaySeat(game.dealer) : null;
  const displayTurn: Seat | null = game?.turn ? displaySeat(game.turn) : null;
  const displayPasses: Seat[] = (game?.bidding?.passes ?? []).map((s) => displaySeat(s as Seat));

  // Maps each display position back to the real seat it represents for the local player.
  const displaySeats: Record<Seat, Seat> = useMemo(() => {
    if (!mySeat) return { N: "N", E: "E", S: "S", W: "W" };
    const m: Record<Seat, Seat> = { N: "N", E: "E", S: "S", W: "W" };
    (SEATS as Seat[]).forEach((real) => {
      const disp = realToDisplaySeat(real, mySeat);
      m[disp] = real;
    });
    return m;
  }, [mySeat]);

  // Display name of the player whose turn it currently is.
  const turnName =
    game?.turn && game.seats[game.turn]
      ? players[game.seats[game.turn] as string]?.name || (displayTurn ?? game.turn)
      : displayTurn ?? game?.turn;

  // Returns the display name for a real seat, or "Open" if unoccupied.
  const seatLabel = (realSeat: Seat) => {
    if (!game) return "Open";
    const seatUid = game.seats[realSeat];
    if (!seatUid) return "Open";
    return players[seatUid]?.name || "Taken";
  };

  // Determines which cards in the local player's hand are legally playable.
  // If `playableSet` is null, all cards are playable (e.g. when leading a trick).
  const playableInfo = useMemo(() => {
    if (!game || game.phase !== "playing" || !isMyTurn || !mySeat || !game.trump) {
      return { mustFollow: null as Suit | null, playableSet: null as Set<CardCode> | null };
    }

    const trump = game.trump;
    const trick = game.currentTrick;
    const cards = trick?.cards ?? {};
    const trickStarted = Object.keys(cards).length > 0;
    const leadSuit = trickStarted ? (trick?.leadSuit ?? null) : null;

    // Leading a trick — any card is legal.
    if (!leadSuit) {
      return { mustFollow: null, playableSet: null };
    }

    const mustFollow = hasSuitInHand(myHand, leadSuit, trump) ? leadSuit : null;

    // Player cannot follow suit — any card is legal.
    if (!mustFollow) {
      return { mustFollow: null, playableSet: null };
    }

    // Player must follow suit — restrict to cards of the lead suit.
    const playable = new Set<CardCode>();
    myHand.forEach((c) => {
      if (effectiveSuit(c, trump) === mustFollow) playable.add(c);
    });

    return { mustFollow, playableSet: playable };
  }, [game, isMyTurn, mySeat, myHand]);

  // ---------------------------------------------------------------------------
  // Render Helper — Seat
  // ---------------------------------------------------------------------------
  // Renders a SeatCard at the given display position with the correct grid placement.

  const renderSeat = (displayPos: Seat, gridColumn: string, gridRow: string) => {
    if (!game) return null;
    const realSeat = displaySeats[displayPos];

    return (
      <div style={{ gridColumn, gridRow }}>
        <SeatCard
          seat={displayPos}
          label={seatLabel(realSeat)}
          isYou={mySeat === realSeat}
          isTurn={game.turn === realSeat}
          teamLabel={teamUi.labelForTeam[teamKeyForSeat(realSeat)]}
          isDealer={game.dealer === realSeat}
          isSittingOut={goingAlone && realSeat === partnerSeatReal}
          canClaim={!!uid && !game.seats[realSeat] && !mySeat}
          playedCard={
            (game.phase === "playing" || game.phase === "trick_complete")
              ? (game.currentTrick?.cards?.[realSeat] ?? null)
              : null
          }
          onClaim={() => claimSeat(realSeat)}
        />
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  // 1) Establish anonymous Firebase auth (persists per browser profile).
  useEffect(() => {
    ensureAnonAuth()
      .then((u) => setUid(u.uid))
      .catch((e) => setErr(String(e)));
  }, []);

  // 2) Subscribe to the shared game document for real-time state updates.
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

  // 3) Subscribe to the players subcollection for display names and seat assignments.
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

  // 4) Subscribe to the local player's private doc to keep their hand in sync.
  //    Firestore security rules ensure only the owning player can read this doc.
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

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  // Atomically claims an open seat for the local player.
  async function claimSeat(seat: Seat) {
    if (!gameRef || !uid || !gameId) return;
    if (!hasName) {
      setErr("Please enter a name before joining.");
      return;
    }

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

      // Write the player's name and seat to their player doc.
      await setDoc(
        doc(db, "games", gameId, "players", uid),
        {
          uid,
          name: savedName || localStorage.getItem("playerName") || "Player",
          seat,
          joinedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  // Copies the share link to the clipboard, with a legacy execCommand fallback.
  async function copyShareLink(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  // Shuffles and deals a new hand, writes player hands to their private docs,
  // and transitions the game from lobby to bidding_round_1.
  async function startHand() {
    if (!gameId || !uid || !gameRef || !game) return;

    setErr(null);

    const allFilled = (SEATS as Seat[]).every((seat) => !!game.seats[seat]);
    if (!allFilled) {
      setErr("Need all 4 seats filled to start a hand.");
      return;
    }

    const score = game.score ?? { NS: 0, EW: 0 };
    const winner = winningTeam(score, 10);

    if (game.status === "finished" || winner) {
      setErr(
        `Game over — ${winner ? (winner === "NS" ? "Team A" : "Team B") : "a team"} reached 10.`
      );
      return;
    }

    const dealer: Seat = (game.dealer ?? "N") as Seat;
    const firstToAct: Seat = nextSeat(dealer);

    const deck = shuffle(createEuchreDeck());

    // Build the deal order: clockwise starting from the player left of the dealer.
    const order: Seat[] = [];
    let cursor = nextSeat(dealer);
    for (let i = 0; i < 4; i++) {
      order.push(cursor);
      cursor = nextSeat(cursor);
    }

    // Deal 5 cards to each seat, one at a time in clockwise order.
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
      goingAlone: null,
      partnerSeat: null,
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

    // Write each player's hand to their private player doc.
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

  // Records a pass in bidding round 1. Advances to round 2 if all 4 players pass.
  async function bidPassRound1() {
    if (isGameFinished) return;
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
        // All four players passed — advance to round 2.
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

  // Orders up the upcard in round 1, making its suit trump and moving to dealer_discard.
  // If goingAlone is true, stores the partner seat so they sit out the hand.
  async function bidOrderUp(goingAlone = false) {
    if (isGameFinished) return;
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
      const partner = goingAlone ? partnerOf(mySeat) : null;

      tx.update(gameRef, {
        status: "bidding",
        phase: "dealer_discard",
        trump,
        makerSeat: mySeat,
        goingAlone: goingAlone || null,
        partnerSeat: partner,
        bidding: {
          round: 1,
          passes: g.bidding?.passes ?? [],
          orderedUpBy: mySeat,
        },
        updatedAt: serverTimestamp(),
        turn: g.dealer, // dealer must pick up the upcard and discard
      });
    });

    setGoAloneIntent(false);
  }

  // Records a pass in bidding round 2.
  // The dealer cannot pass (screw-the-dealer rule) — enforced client- and server-side.
  async function bidPassRound2() {
    if (isGameFinished) return;
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
      if (mySeat === g.dealer) return; // double-check inside transaction

      const passes = g.bidding?.passes ?? [];
      const nextPasses = passes.includes(mySeat) ? passes : [...passes, mySeat];

      if (nextPasses.length >= 3) {
        // Three non-dealer players have passed — dealer is now stuck and must choose.
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

  // Calls a trump suit in round 2. The upcard suit is not allowed.
  // Transitions directly to playing (no dealer discard in round 2).
  // If goingAlone is true, the maker's partner sits out the hand.
  async function bidCallTrump(suit: Suit, goingAlone = false) {
    if (isGameFinished) return;
    if (!gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_2") return;
    if (game.turn !== mySeat) return;
    if (!game.upcard) return;

    const forbidden = suitCharFromCard(game.upcard);
    if (suit === forbidden) {
      setErr("You can't choose the upcard suit in round 2.");
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

      const partner = goingAlone ? partnerOf(mySeat) : null;

      // In round 2 there is no dealer discard, so skip straight to playing.
      // If going alone, skip the partner's seat when determining first lead.
      let firstLead = nextSeat(g.dealer);
      if (goingAlone && firstLead === partner) firstLead = nextSeat(firstLead);

      tx.update(gameRef, {
        status: "playing",
        phase: "playing",
        trump: suit,
        makerSeat: mySeat,
        goingAlone: goingAlone || null,
        partnerSeat: partner,
        bidding: {
          round: 2,
          passes: g.bidding?.passes ?? [],
          orderedUpBy: null,
        },
        updatedAt: serverTimestamp(),
        turn: firstLead,
      });
    });

    setGoAloneIntent(false);
  }

  // Handles the dealer picking up the upcard and discarding a card from their combined 6-card hand.
  async function dealerPickupAndDiscard(discard: CardCode) {
    if (isGameFinished) return;
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

        const dealerUid = g.seats[g.dealer];
        if (!dealerUid) throw new Error("Dealer missing");
        const dealerRef = doc(db, "games", gameId, "players", dealerUid);

        const playerSnap = await tx.get(dealerRef);
        if (!playerSnap.exists()) throw new Error("Dealer player doc missing");
        const p = playerSnap.data() as PlayerDoc;

        const hand = (p.hand ?? []) as CardCode[];
        if (hand.length !== 5) throw new Error("Dealer hand not 5 cards");

        // Temporarily combine the dealer's hand with the upcard, then remove the discard.
        const combined: CardCode[] = [...hand, g.upcard];
        const discardIdx = combined.indexOf(discard);
        if (discardIdx === -1) throw new Error("Discard card not found");

        const nextHand = combined.slice();
        nextHand.splice(discardIdx, 1);
        if (nextHand.length !== 5) throw new Error("Resulting hand not 5 cards");

        const nextKitty = [...(g.kitty ?? []), discard];

        tx.update(dealerRef, { hand: nextHand, updatedAt: serverTimestamp() });

        // Determine first lead, skipping the partner if going alone.
        const partner = g.goingAlone ? g.partnerSeat : null;
        let firstLead = nextSeat(g.dealer);
        if (partner && firstLead === partner) firstLead = nextSeat(firstLead);

        tx.update(gameRef, {
          status: "playing",
          phase: "playing",
          kitty: nextKitty,
          updatedAt: serverTimestamp(),
          turn: firstLead,
        });
      });

      setErr(null);
      setSelectedCard(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  // Plays a card from the local player's hand into the current trick.
  // Enforces follow-suit rules, resolves the trick winner when all 4 cards are played,
  // scores the hand after 5 tricks, and transitions the game state accordingly.
  async function playCard(code: CardCode) {
    if (isGameFinished) return;
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

        // Enforce follow-suit (only applies when not leading).
        if (!isNewTrick) {
          const mustFollow = hasSuitInHand(hand, leadSuit, trump);
          if (mustFollow && effectiveSuit(code, trump) !== leadSuit) {
            throw new Error("Must follow suit");
          }
        }

        const nextHand = removeOneCard(hand, code);

        const nextCards: Partial<Record<Seat, CardCode>> = {
          ...existingCards,
          [mySeat]: code,
        };

        const currentTrickNumber = trick?.trickNumber ?? 1;
        const seatsPlayed = Object.keys(nextCards).length;

        // When going alone, the trick completes after 3 cards (partner sits out).
        const partnerSeat = g.goingAlone ? (g.partnerSeat as Seat | null) : null;
        const trickSize = partnerSeat ? 3 : 4;

        if (seatsPlayed === trickSize) {
          // All active players have played — determine the winner and pause so every
          // player can see the completed trick before it is cleared from the table.
          const trickWinner = winnerOfTrick(nextCards, leadSeat, trump, leadSuit);

          tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });

          // Write trick_complete: cards stay on the table, scoring is deferred until
          // the trick winner presses "Next Trick" (or "Finish Hand" on trick 5).
          tx.update(gameRef, {
            updatedAt: serverTimestamp(),
            phase: "trick_complete",
            turn: trickWinner, // trick winner is the one who advances
            currentTrick: {
              trickNumber: currentTrickNumber,
              leadSeat,
              leadSuit,
              cards: nextCards,
              trickWinner, // stored so advanceTrick can read it without recomputing
            },
          });
          return;
        }

        // Trick not yet complete — advance to the next active player's turn,
        // skipping the partner seat if going alone.
        tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });

        let nextTurn = nextSeat(g.turn);
        if (partnerSeat && nextTurn === partnerSeat) nextTurn = nextSeat(nextTurn);

        tx.update(gameRef, {
          updatedAt: serverTimestamp(),
          currentTrick: {
            trickNumber: currentTrickNumber,
            leadSeat,
            leadSuit,
            cards: nextCards,
          },
          turn: nextTurn,
        });
      });

      setErr(null);
      setSelectedCard(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  // Called by the trick winner after all players have seen the completed trick.
  // Scores the trick, then either starts the next trick or ends the hand.
  async function advanceTrick() {
    if (isGameFinished) return;
    if (!gameRef || !gameId || !game || !uid || !mySeat) return;
    if (game.phase !== "trick_complete") return;
    if (game.turn !== mySeat) return; // only the trick winner may advance

    const trick = game.currentTrick;
    if (!trick?.trickWinner) return;

    try {
      await runTransaction(db, async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists()) throw new Error("Game missing");
        const g = gameSnap.data() as GameDoc;

        if (g.phase !== "trick_complete") return;
        if (g.turn !== mySeat) return;
        if (!g.trump) throw new Error("Trump not set");

        const completedTrick = g.currentTrick;
        if (!completedTrick?.trickWinner) throw new Error("Trick winner missing");

        const trickWinner = completedTrick.trickWinner as Seat;
        const currentTrickNumber = completedTrick.trickNumber;

        const prevTaken = g.tricksTaken ?? { NS: 0, EW: 0 };
        const winTeam = teamOf(trickWinner);
        const nextTaken = {
          NS: prevTaken.NS + (winTeam === "NS" ? 1 : 0),
          EW: prevTaken.EW + (winTeam === "EW" ? 1 : 0),
        };

        const nextWinners = [...((g.trickWinners ?? []) as Seat[]), trickWinner];

        if (currentTrickNumber >= 5) {
          // Hand is over — score and return to lobby (or end the game).
          const makerSeat = g.makerSeat as Seat | null;
          const makerTeam: TeamKey | null = makerSeat ? teamKeyForSeat(makerSeat) : null;
          const defenseTeam: TeamKey | null = makerTeam ? otherTeam(makerTeam) : null;

          const prevScore = g.score ?? { NS: 0, EW: 0 };
          const nextScore = { ...prevScore };

          if (makerTeam && defenseTeam) {
            const makerTricks = nextTaken[makerTeam];
            if (makerTricks >= 5) {
              // March: 4 points going alone, 2 points with partner
              nextScore[makerTeam] += g.goingAlone ? 4 : 2;
            } else if (makerTricks >= 3) {
              nextScore[makerTeam] += 1; // made it
            } else {
              nextScore[defenseTeam] += 2; // euchred
            }
          }

          const gameWinner = winningTeam(nextScore, 10);
          const nextDealer: Seat = nextSeat(g.dealer);

          tx.update(gameRef, {
            updatedAt: serverTimestamp(),
            tricksTaken: nextTaken,
            trickWinners: nextWinners,
            score: nextScore,
            status: gameWinner ? "finished" : "lobby",
            winnerTeam: gameWinner,
            dealer: nextDealer,
            turn: nextDealer,
            phase: "lobby",
            currentTrick: null,
            upcard: null,
            kitty: null,
            trump: null,
            makerSeat: null,
            goingAlone: null,
            partnerSeat: null,
            bidding: null,
          });
          return;
        }

        // Hand continues — winner leads the next trick, skipping partner if going alone.
        const partnerSeat = g.goingAlone ? (g.partnerSeat as Seat | null) : null;
        let nextLeadTurn = trickWinner;
        if (partnerSeat && nextLeadTurn === partnerSeat) nextLeadTurn = nextSeat(nextLeadTurn);

        tx.update(gameRef, {
          updatedAt: serverTimestamp(),
          tricksTaken: nextTaken,
          trickWinners: nextWinners,
          phase: "playing",
          currentTrick: {
            trickNumber: currentTrickNumber + 1,
            leadSeat: nextLeadTurn,
            leadSuit: null,
            cards: {},
          },
          turn: nextLeadTurn,
        });
      });

      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* Name gate — shown until the player enters a display name */}
      {!hasName ? (
        <div className="g-card">
          <h4 style={{ marginTop: 0 }}>Enter your name</h4>
          <div style={{ color: "#555", marginBottom: 10 }}>
            You'll need a name before you can join or take actions in this game.
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="Your name"
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #ccc",
                fontSize: 16, // prevents iOS zoom-on-focus
              }}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") saveName();
              }}
            />
            <button className="g-btn" onClick={saveName} disabled={!nameDraft.trim()}>
              Continue
            </button>
          </div>
        </div>
      ) : null}

      {/* Game ID and share link */}
      <div style={{ marginBottom: 12 }}>
        <div>
          <b>Game ID:</b> {gameId}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Share link:</b>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <a href={url} target="_blank" rel="noreferrer">
              {url}
            </a>

            <button
              type="button"
              onClick={() => copyShareLink(url)}
              className="g-copy-btn"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <CardThemePicker />
      </div>

      {!game ? (
        <p>Loading…</p>
      ) : (
        <>
          {/* Turn banner — highlights whose turn it is and what action is expected */}
          <div className={`g-banner${isMyTurn ? " my-turn" : ""}`}>
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
              goingAlone && mySeat === partnerSeatReal ? (
                <>🪑 Your partner is going alone — you're sitting out this hand</>
              ) : mySeat === game.dealer ? (
                <>🟢 Dealer: pick up the upcard and discard</>
              ) : (
                <>⏳ Waiting for dealer ({displayDealer ?? game.dealer}) to discard…</>
              )
            ) : game.phase === "trick_complete" ? (
              isMyTurn ? (
                <>🟢 You won the trick — continue when ready</>
              ) : (
                <>⏳ Waiting for {turnName} to continue…</>
              )
            ) : game.phase === "playing" ? (
              goingAlone && mySeat === partnerSeatReal ? (
                <>🪑 Your partner is going alone — you're sitting out this hand</>
              ) : isMyTurn ? (
                <>🟢 Your turn</>
              ) : (
                <>⏳ Waiting for {turnName}…</>
              )
            ) : (
              <>Waiting…</>
            )}
          </div>

          {err && <div className="g-alert">{err}</div>}

          {/* Winner banner — shown when the game has ended */}
          {game?.status === "finished" && winnerLabel ? (
            <div className="g-winner">
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 0.2 }}>
                  🏆 {winnerLabel} wins!
                </div>
              </div>
            </div>
          ) : null}

          {/* Score display */}
          <div className="g-score-row">
            <span className="g-score-pill">
              <span className="g-score-label">Team A</span>
              <span style={{ minWidth: 18, textAlign: "center" }}>{scoreNS}</span>
              <span className="g-score-sep">–</span>
              <span style={{ minWidth: 18, textAlign: "center" }}>{scoreEW}</span>
              <span className="g-score-label">Team B</span>
            </span>
          </div>

          {/* Trick progress tracker (visible during play and trick review) */}
          {(game.phase === "playing" || game.phase === "trick_complete") && (
            <TrickMeter
              aLabel={teamUi.labelForTeam[teamUi.aTeam]}
              aCount={game.tricksTaken?.[teamUi.aTeam] ?? 0}
              bLabel={teamUi.labelForTeam[teamUi.bTeam]}
              bCount={game.tricksTaken?.[teamUi.bTeam] ?? 0}
            />
          )}

          {/* Trump indicator (visible during play, dealer discard, and trick review) */}
          {(game.phase === "playing" || game.phase === "dealer_discard" || game.phase === "trick_complete") && game.trump && (
            <TrumpIndicator suit={suitSymbol(game.trump)} />
          )}

          {/* Table layout — 3×3 grid with seats at N/S/E/W and center empty */}
          <div className="g-table">
            {renderSeat("N", "2 / 3", "1 / 2")}
            {renderSeat("W", "1 / 2", "2 / 3")}
            {renderSeat("E", "3 / 4", "2 / 3")}
            {renderSeat("S", "2 / 3", "3 / 4")}
          </div>

          {/* Upcard (hidden once play begins) */}
          <div>
            {game.upcard && game.phase !== "playing" && game.phase !== "trick_complete" && (
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
          </div>

          {/* Bidding UI — Round 1: order up or pass */}
          {game.phase === "bidding_round_1" && (
            <div className="g-card" style={{ marginTop: 12 }}>
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
                  onClick={() => bidOrderUp(false)}
                  disabled={!mySeat || mySeat !== game.turn}
                  className="g-btn" style={{ flex: 1 }}
                >
                  Order Up
                </button>
                <button
                  onClick={() => bidOrderUp(true)}
                  disabled={!mySeat || mySeat !== game.turn}
                  className="g-btn" style={{ flex: 1 }}
                >
                  Go Alone
                </button>
                <button
                  onClick={bidPassRound1}
                  disabled={!mySeat || mySeat !== game.turn}
                  className="g-btn" style={{ flex: 1 }}
                >
                  Pass
                </button>
              </div>
            </div>
          )}

          {/* Bidding UI — Round 2: call trump or pass (dealer cannot pass) */}
          {game.phase === "bidding_round_2" && (
            <div className="g-card" style={{ marginTop: 12 }}>
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

              {mySeat && mySeat === game.turn && (
                <div style={{ marginBottom: 10 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={goAloneIntent}
                      onChange={(e) => setGoAloneIntent(e.target.checked)}
                    />
                    <span style={{ fontSize: 14 }}>Go alone (4 pts for a march)</span>
                  </label>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                {round2AllowedSuits.map((suit) => (
                  <button
                    key={suit}
                    onClick={() => bidCallTrump(suit, goAloneIntent)}
                    disabled={!mySeat || mySeat !== game.turn}
                    className="g-btn" style={{ padding: "12px 10px" }}
                  >
                    {suitSymbol(suit)}
                  </button>
                ))}
              </div>

              {!isDealerStuck && (
                <button
                  onClick={bidPassRound2}
                  disabled={!mySeat || mySeat !== game.turn}
                  className="g-btn" style={{ width: "100%", marginTop: 10 }}
                >
                  Pass
                </button>
              )}

              {isDealerStuck && (
                <div style={{ marginTop: 10, fontSize: 13, color: "#b00" }}>
                  Screw the dealer: you can't pass here.
                </div>
              )}
            </div>
          )}

          {/* Dealer discard UI — dealer selects a card to discard after picking up the upcard */}
          {game.phase === "dealer_discard" && (
            <div className="g-card" style={{ marginTop: 12 }}>
              <h4 style={{ marginTop: 0 }}>Dealer: Pick up & Discard</h4>

              {game.trump && (
                <div style={{ marginBottom: 8 }}>
                  <TrumpIndicator suit={suitSymbol(game.trump)} />
                </div>
              )}

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
                    className="g-btn" style={{ width: "100%" }}
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

          {/* Trick complete — all 4 cards visible; trick winner advances */}
          {game.phase === "trick_complete" && game.currentTrick?.trickWinner && (() => {
            const trickWinnerSeat = game.currentTrick.trickWinner as Seat;
            const trickWinnerUid = game.seats[trickWinnerSeat];
            const trickWinnerName = trickWinnerUid
              ? players[trickWinnerUid]?.name || displaySeat(trickWinnerSeat)
              : displaySeat(trickWinnerSeat);
            const isLastTrick = (game.currentTrick?.trickNumber ?? 0) >= 5;
            const iWonTheTrick = mySeat === trickWinnerSeat;

            return (
              <div className="g-card" style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 8 }}>
                  {iWonTheTrick ? "You won the trick! 🎉" : `${trickWinnerName} won the trick`}
                </div>

                {iWonTheTrick ? (
                  <button
                    onClick={advanceTrick}
                    className="g-btn" style={{ width: "100%" }}
                  >
                    {isLastTrick ? "Finish Hand" : "Next Trick"}
                  </button>
                ) : (
                  <div style={{ color: "#555" }}>
                    Waiting for {trickWinnerName} to continue…
                  </div>
                )}
              </div>
            );
          })()}

          {/* Deal button — only visible to the dealer when in the lobby phase */}
          {canDeal ? (
            <button
              onClick={startHand}
              className="g-btn" style={{ width: "100%", marginBottom: 12 }}
            >
              Deal
            </button>
          ) : null}

          {/* Local player's hand */}
          <h4 style={{ marginTop: 0 }}>Your Hand</h4>
          <div className="g-hand">
            {displayHand.map((code, i) => {
              const { rank, suit } = parseCard(code);

              const isPlayingTurn = game?.phase === "playing" && isMyTurn;
              const { mustFollow, playableSet } = playableInfo;
              const isPlayable = !isPlayingTurn || !playableSet ? true : playableSet.has(code);
              // Cards are never interactive during trick_complete — we're just showing the hand.
              const isInteractive = game?.phase !== "trick_complete";

              return (
                <div
                  key={code + i}
                  style={{
                    opacity: isPlayable && isInteractive ? 1 : 0.35,
                    pointerEvents: isPlayable && isInteractive ? "auto" : "none",
                    transition: "opacity 120ms ease",
                  }}
                  title={!isPlayable && mustFollow ? `Must follow ${mustFollow}` : undefined}
                >
                  <Card
                    rank={rankLabel(rank)}
                    suit={suitSymbol(suit)}
                    selected={selectedCard === i}
                    onClick={() => {
                      if (game?.phase === "dealer_discard") {
                        // Tap to select; tap again to deselect
                        setSelectedCard(selectedCard === i ? null : i);
                        return;
                      }

                      if (game?.phase === "playing" && isMyTurn) {
                        // Tap to play immediately
                        playCard(code);
                        return;
                      }

                      // Other phases: selection only (no immediate action)
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
