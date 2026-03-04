import {
  doc,
  DocumentReference,
  runTransaction,
  serverTimestamp,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

import type { CardCode } from "../lib/cards";
import { createEuchreDeck, shuffle } from "../lib/deal";
import {
  nextSeat,
  partnerOf,
  suitCharFromCard,
  effectiveSuit,
  hasSuitInHand,
  removeOneCard,
  winnerOfTrick,
  teamKeyForSeat,
  teamOf,
  otherTeam,
  winningTeam,
} from "../lib/gameLogic";
import type { GameDoc, PlayerDoc, Seat, Suit } from "../types/game";
import { SEATS } from "../types/game";

interface ActionDeps {
  gameRef: DocumentReference | null;
  gameId: string | undefined;
  game: GameDoc | null;
  uid: string | null;
  mySeat: Seat | null;
  hasName: boolean;
  savedName: string;
  players: Record<string, PlayerDoc>;
  isGameFinished: boolean;
  setErr: (e: string | null) => void;
  setSelectedCard: (i: number | null) => void;
  setGoAloneIntent: (v: boolean) => void;
  setCopied: (v: boolean) => void;
}

// Returns all Firestore action functions for the game screen.
// Separating these from the component keeps Game.tsx focused on state and render.
export function useGameActions(deps: ActionDeps) {
  const {
    gameRef, gameId, game, uid, mySeat, hasName, savedName,
    players, isGameFinished,
    setErr, setSelectedCard, setGoAloneIntent, setCopied,
  } = deps;

  // Atomically claims an open seat for the local player.
  async function claimSeat(seat: Seat) {
    if (!gameRef || !uid || !gameId) return;
    if (!hasName) { setErr("Please enter a name before joining."); return; }

    try {
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(gameRef);
        if (!snap.exists()) throw new Error("Game missing");
        const data = snap.data() as GameDoc;

        if (data.seats[seat]) throw new Error("Seat already taken");
        if (Object.values(data.seats).includes(uid)) throw new Error("You already claimed a seat");

        tx.update(gameRef, { [`seats.${seat}`]: uid, updatedAt: serverTimestamp() });
      });

      await setDoc(
        doc(db, "games", gameId, "players", uid),
        { uid, name: savedName || localStorage.getItem("playerName") || "Player", seat, joinedAt: serverTimestamp() },
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

  // Shuffles and deals a new hand; transitions the game from lobby to bidding_round_1.
  async function startHand() {
    if (!gameId || !uid || !gameRef || !game) return;
    setErr(null);

    const allFilled = (SEATS as Seat[]).every((seat) => !!game.seats[seat]);
    if (!allFilled) { setErr("Need all 4 seats filled to start a hand."); return; }

    const winner = winningTeam(game.score ?? { NS: 0, EW: 0 }, 10);
    if (game.status === "finished" || winner) {
      setErr(`Game over — ${winner === "NS" ? "Team A" : winner === "EW" ? "Team B" : "a team"} reached 10.`);
      return;
    }

    const dealer: Seat = (game.dealer ?? "N") as Seat;
    const firstToAct: Seat = nextSeat(dealer);
    const deck = shuffle(createEuchreDeck());

    // Build deal order clockwise from left of dealer, deal 5 cards each.
    const order: Seat[] = [];
    let cursor = nextSeat(dealer);
    for (let i = 0; i < 4; i++) { order.push(cursor); cursor = nextSeat(cursor); }

    const hands: Record<Seat, CardCode[]> = { N: [], E: [], S: [], W: [] };
    let idx = 0;
    for (let c = 0; c < 5; c++) for (const seat of order) hands[seat].push(deck[idx++] as CardCode);

    const upcard = deck[idx++] as CardCode;
    const kitty = deck.slice(idx) as CardCode[];
    const batch = writeBatch(db);

    batch.update(gameRef, {
      status: "bidding", phase: "bidding_round_1",
      bidding: { round: 1, passes: [], orderedUpBy: null },
      trump: null, makerSeat: null, goingAlone: null, partnerSeat: null,
      currentTrick: null, tricksTaken: { NS: 0, EW: 0 }, trickWinners: [],
      updatedAt: serverTimestamp(), dealer, turn: firstToAct, upcard, kitty,
      handNumber: (game.handNumber ?? 0) + 1,
    });

    for (const seat of SEATS as Seat[]) {
      const seatUid = game.seats[seat]!;
      batch.set(
        doc(db, "games", gameId, "players", seatUid),
        { uid: seatUid, name: players[seatUid]?.name ?? "Player", seat, hand: hands[seat], updatedAt: serverTimestamp() },
        { merge: true }
      );
    }

    await batch.commit();
    setErr(null);
  }

  // Records a pass in bidding round 1. Advances to round 2 if all 4 players pass.
  async function bidPassRound1() {
    if (isGameFinished || !gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_1" || game.turn !== mySeat) return;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game missing");
      const g = snap.data() as GameDoc;
      if (g.phase !== "bidding_round_1" || g.turn !== mySeat) return;

      const passes = g.bidding?.passes ?? [];
      const nextPasses = passes.includes(mySeat) ? passes : [...passes, mySeat];

      if (nextPasses.length >= 4) {
        tx.update(gameRef, {
          phase: "bidding_round_2",
          bidding: { round: 2, passes: [], orderedUpBy: null },
          updatedAt: serverTimestamp(), turn: nextSeat(g.dealer),
        });
        return;
      }
      tx.update(gameRef, {
        bidding: { round: 1, passes: nextPasses, orderedUpBy: null },
        updatedAt: serverTimestamp(), turn: nextSeat(g.turn),
      });
    });
  }

  // Orders up the upcard in round 1, making its suit trump and moving to dealer_discard.
  async function bidOrderUp(goingAlone = false) {
    if (isGameFinished || !gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_1" || game.turn !== mySeat || !game.upcard) return;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game missing");
      const g = snap.data() as GameDoc;
      if (g.phase !== "bidding_round_1" || g.turn !== mySeat || !g.upcard) return;

      const trump = suitCharFromCard(g.upcard);
      const partner = goingAlone ? partnerOf(mySeat) : null;

      tx.update(gameRef, {
        status: "bidding", phase: "dealer_discard", trump,
        makerSeat: mySeat, goingAlone: goingAlone || null, partnerSeat: partner,
        bidding: { round: 1, passes: g.bidding?.passes ?? [], orderedUpBy: mySeat },
        updatedAt: serverTimestamp(), turn: g.dealer,
      });
    });

    setGoAloneIntent(false);
  }

  // Records a pass in bidding round 2. Dealer cannot pass (screw-the-dealer rule).
  async function bidPassRound2() {
    if (isGameFinished || !gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_2" || game.turn !== mySeat) return;
    if (mySeat === game.dealer) { setErr("Screw the dealer: dealer must choose a trump suit."); return; }

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game missing");
      const g = snap.data() as GameDoc;
      if (g.phase !== "bidding_round_2" || g.turn !== mySeat || mySeat === g.dealer) return;

      const passes = g.bidding?.passes ?? [];
      const nextPasses = passes.includes(mySeat) ? passes : [...passes, mySeat];

      if (nextPasses.length >= 3) {
        tx.update(gameRef, {
          bidding: { round: 2, passes: nextPasses, orderedUpBy: null },
          updatedAt: serverTimestamp(), turn: g.dealer,
        });
        return;
      }
      tx.update(gameRef, {
        bidding: { round: 2, passes: nextPasses, orderedUpBy: null },
        updatedAt: serverTimestamp(), turn: nextSeat(g.turn),
      });
    });
  }

  // Calls a trump suit in round 2. Upcard suit is not allowed.
  async function bidCallTrump(suit: Suit, goingAlone = false) {
    if (isGameFinished || !gameRef || !game || !mySeat) return;
    if (game.phase !== "bidding_round_2" || game.turn !== mySeat || !game.upcard) return;

    const forbidden = suitCharFromCard(game.upcard);
    if (suit === forbidden) { setErr("You can't choose the upcard suit in round 2."); return; }

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists()) throw new Error("Game missing");
      const g = snap.data() as GameDoc;
      if (g.phase !== "bidding_round_2" || g.turn !== mySeat || !g.upcard) return;
      if (suit === suitCharFromCard(g.upcard)) return;

      const partner = goingAlone ? partnerOf(mySeat) : null;
      let firstLead = nextSeat(g.dealer);
      if (goingAlone && firstLead === partner) firstLead = nextSeat(firstLead);

      tx.update(gameRef, {
        status: "playing", phase: "playing", trump: suit,
        makerSeat: mySeat, goingAlone: goingAlone || null, partnerSeat: partner,
        bidding: { round: 2, passes: g.bidding?.passes ?? [], orderedUpBy: null },
        updatedAt: serverTimestamp(), turn: firstLead,
      });
    });

    setGoAloneIntent(false);
  }

  // Dealer picks up the upcard and discards one card from their combined 6-card hand.
  async function dealerPickupAndDiscard(discard: CardCode) {
    if (isGameFinished || !gameRef || !gameId || !game || !uid || !mySeat) return;
    if (game.phase !== "dealer_discard" || mySeat !== game.dealer || game.turn !== game.dealer || !game.upcard) return;

    try {
      await runTransaction(db, async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists()) throw new Error("Game missing");
        const g = gameSnap.data() as GameDoc;
        if (g.phase !== "dealer_discard" || g.turn !== g.dealer || !g.upcard) return;

        const dealerUid = g.seats[g.dealer];
        if (!dealerUid) throw new Error("Dealer missing");
        const dealerRef = doc(db, "games", gameId, "players", dealerUid);

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

        const partner = g.goingAlone ? g.partnerSeat : null;
        let firstLead = nextSeat(g.dealer);
        if (partner && firstLead === partner) firstLead = nextSeat(firstLead);

        tx.update(gameRef, {
          status: "playing", phase: "playing", kitty: nextKitty,
          updatedAt: serverTimestamp(), turn: firstLead,
        });
      });

      setErr(null);
      setSelectedCard(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  // Plays a card into the current trick; enforces follow-suit and resolves trick completion.
  async function playCard(code: CardCode) {
    if (isGameFinished || !gameRef || !gameId || !game || !uid || !mySeat) return;
    if (game.phase !== "playing") return;

    try {
      await runTransaction(db, async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists()) throw new Error("Game missing");
        const g = gameSnap.data() as GameDoc;
        if (g.phase !== "playing" || g.turn !== mySeat || !g.trump) return;

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
        const leadSuit: Suit = isNewTrick ? effectiveSuit(code, trump) : (trick!.leadSuit as Suit);

        if (!isNewTrick) {
          const mustFollow = hasSuitInHand(hand, leadSuit, trump);
          if (mustFollow && effectiveSuit(code, trump) !== leadSuit) throw new Error("Must follow suit");
        }

        const nextHand = removeOneCard(hand, code);
        const nextCards: Partial<Record<Seat, CardCode>> = { ...existingCards, [mySeat]: code };
        const currentTrickNumber = trick?.trickNumber ?? 1;
        const seatsPlayed = Object.keys(nextCards).length;
        const partnerSeat = g.goingAlone ? (g.partnerSeat as Seat | null) : null;
        const trickSize = partnerSeat ? 3 : 4;

        if (seatsPlayed === trickSize) {
          const trickWinner = winnerOfTrick(nextCards, leadSeat, trump, leadSuit);
          tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });
          tx.update(gameRef, {
            updatedAt: serverTimestamp(), phase: "trick_complete", turn: trickWinner,
            currentTrick: { trickNumber: currentTrickNumber, leadSeat, leadSuit, cards: nextCards, trickWinner },
          });
          return;
        }

        tx.update(playerRef, { hand: nextHand, updatedAt: serverTimestamp() });
        let nextTurn = nextSeat(g.turn);
        if (partnerSeat && nextTurn === partnerSeat) nextTurn = nextSeat(nextTurn);
        tx.update(gameRef, {
          updatedAt: serverTimestamp(),
          currentTrick: { trickNumber: currentTrickNumber, leadSeat, leadSuit, cards: nextCards },
          turn: nextTurn,
        });
      });

      setErr(null);
      setSelectedCard(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  // Scores the completed trick; starts the next trick or ends the hand.
  async function advanceTrick() {
    if (isGameFinished || !gameRef || !gameId || !game || !uid || !mySeat) return;
    if (game.phase !== "trick_complete" || game.turn !== mySeat) return;
    if (!game.currentTrick?.trickWinner) return;

    try {
      await runTransaction(db, async (tx) => {
        const gameSnap = await tx.get(gameRef);
        if (!gameSnap.exists()) throw new Error("Game missing");
        const g = gameSnap.data() as GameDoc;
        if (g.phase !== "trick_complete" || g.turn !== mySeat || !g.trump) return;

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
          const makerSeat = g.makerSeat as Seat | null;
          const makerTeam = makerSeat ? teamKeyForSeat(makerSeat) : null;
          const defenseTeam = makerTeam ? otherTeam(makerTeam) : null;
          const prevScore = g.score ?? { NS: 0, EW: 0 };
          const nextScore = { ...prevScore };

          if (makerTeam && defenseTeam) {
            const makerTricks = nextTaken[makerTeam];
            if (makerTricks >= 5) nextScore[makerTeam] += g.goingAlone ? 4 : 2;
            else if (makerTricks >= 3) nextScore[makerTeam] += 1;
            else nextScore[defenseTeam] += 2;
          }

          const gameWinner = winningTeam(nextScore, 10);
          const nextDealer: Seat = nextSeat(g.dealer);

          tx.update(gameRef, {
            updatedAt: serverTimestamp(), tricksTaken: nextTaken, trickWinners: nextWinners,
            score: nextScore, status: gameWinner ? "finished" : "lobby",
            winnerTeam: gameWinner, dealer: nextDealer, turn: nextDealer,
            phase: "lobby", currentTrick: null, upcard: null, kitty: null,
            trump: null, makerSeat: null, goingAlone: null, partnerSeat: null, bidding: null,
          });
          return;
        }

        const partnerSeat = g.goingAlone ? (g.partnerSeat as Seat | null) : null;
        let nextLeadTurn = trickWinner;
        if (partnerSeat && nextLeadTurn === partnerSeat) nextLeadTurn = nextSeat(nextLeadTurn);

        tx.update(gameRef, {
          updatedAt: serverTimestamp(), tricksTaken: nextTaken, trickWinners: nextWinners,
          phase: "playing",
          currentTrick: { trickNumber: currentTrickNumber + 1, leadSeat: nextLeadTurn, leadSuit: null, cards: {} },
          turn: nextLeadTurn,
        });
      });

      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }

  return { claimSeat, copyShareLink, startHand, bidPassRound1, bidOrderUp, bidPassRound2, bidCallTrump, dealerPickupAndDiscard, playCard, advanceTrick };
}
