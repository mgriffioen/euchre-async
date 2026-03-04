/**
 * bot.mjs — Euchre Bot Runner
 *
 * Watches a Firestore game doc and plays automatically for any bot-controlled
 * seats. Uses the Firebase Admin SDK so it bypasses security rules and can
 * read all player hands directly.
 *
 * Usage:
 *   node scripts/bot.mjs <gameId> [seats]
 *
 * Examples:
 *   node scripts/bot.mjs abc123              # bots fill all 4 seats
 *   node scripts/bot.mjs abc123 N,S          # bots fill N and S only
 *   node scripts/bot.mjs abc123 E,W          # you play N/S, bots play E/W
 *
 * Setup: see README note at bottom of this file.
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// =============================================================================
// Config
// =============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load service account from the scripts directory
const serviceAccount = JSON.parse(
  readFileSync(resolve(__dirname, "serviceAccount.json"), "utf8")
);

initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

// How long (ms) the bot waits before taking its turn — feels more natural
// and gives the Firestore snapshot a moment to settle.
const BOT_DELAY_MS = 800;

// =============================================================================
// CLI Args
// =============================================================================

const [, , gameId, seatsArg] = process.argv;

if (!gameId) {
  console.error("Usage: node scripts/bot.mjs <gameId> [N,E,S,W]");
  process.exit(1);
}

const ALL_SEATS = ["N", "E", "S", "W"];
const botSeats = seatsArg
  ? seatsArg.split(",").map((s) => s.trim().toUpperCase())
  : ALL_SEATS;

console.log(`\n🤖 Bot starting for game: ${gameId}`);
console.log(`   Bot seats: ${botSeats.join(", ")}\n`);

// =============================================================================
// Euchre Logic (mirrors Game.tsx — kept minimal)
// =============================================================================

function nextSeat(seat) {
  return ALL_SEATS[(ALL_SEATS.indexOf(seat) + 1) % 4];
}

function partnerOf(seat) {
  return { N: "S", S: "N", E: "W", W: "E" }[seat];
}

function suitOf(code) {
  return code[1]; // e.g. "JS" → "S"
}

function rankOf(code) {
  return code[0]; // e.g. "JS" → "J", "TS" → "T", "9S" → "9"
}

function leftBowerSuit(trump) {
  return { H: "D", D: "H", S: "C", C: "S" }[trump];
}

function isJack(code) {
  return rankOf(code) === "J";
}

function effectiveSuit(code, trump) {
  const s = suitOf(code);
  if (isJack(code) && s === leftBowerSuit(trump)) return trump;
  return s;
}

function isRightBower(code, trump) {
  return isJack(code) && suitOf(code) === trump;
}

function isLeftBower(code, trump) {
  return isJack(code) && suitOf(code) === leftBowerSuit(trump);
}

function rankStrength(code) {
  const r = rankOf(code);
  return { "9": 1, T: 2, J: 3, Q: 4, K: 5, A: 6 }[r] ?? 0;
}

function trickStrength(code, leadSuit, trump) {
  if (isRightBower(code, trump)) return 200;
  if (isLeftBower(code, trump)) return 199;
  const eff = effectiveSuit(code, trump);
  const r = rankStrength(code);
  if (eff === trump) return 150 + r;
  if (eff === leadSuit) return 100 + r;
  return r;
}

function winnerOfTrick(cards, leadSeat, trump, leadSuit) {
  let bestSeat = leadSeat;
  let bestScore = -1;
  for (const [seat, card] of Object.entries(cards)) {
    const score = trickStrength(card, leadSuit, trump);
    if (score > bestScore) {
      bestScore = score;
      bestSeat = seat;
    }
  }
  return bestSeat;
}

function hasSuit(hand, suit, trump) {
  return hand.some((c) => effectiveSuit(c, trump) === suit);
}

function teamOf(seat) {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

function otherTeam(team) {
  return team === "NS" ? "EW" : "NS";
}

function winningTeam(score, target = 10) {
  if (score.NS >= target) return "NS";
  if (score.EW >= target) return "EW";
  return null;
}

// =============================================================================
// Bot Strategy Helpers
// =============================================================================

// Picks a random legal card from the bot's hand given the current trick state.
function pickCard(hand, trick, trump) {
  const cards = trick?.cards ?? {};
  const trickStarted = Object.keys(cards).length > 0;
  const leadSuit = trickStarted ? trick.leadSuit : null;

  let playable = hand;

  if (leadSuit && hasSuit(hand, leadSuit, trump)) {
    playable = hand.filter((c) => effectiveSuit(c, trump) === leadSuit);
  }

  // Random selection — good enough for testing
  return playable[Math.floor(Math.random() * playable.length)];
}

// =============================================================================
// Bot Actions (write to Firestore directly via Admin SDK)
// =============================================================================

async function claimSeat(gameId, seat, botUid, botName) {
  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new Error("Game missing");
    const g = snap.data();

    if (g.seats[seat]) {
      console.log(`  ⚠️  Seat ${seat} already taken`);
      return;
    }

    tx.update(gameRef, {
      [`seats.${seat}`]: botUid,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  await db
    .collection("games")
    .doc(gameId)
    .collection("players")
    .doc(botUid)
    .set(
      {
        uid: botUid,
        name: botName,
        seat,
        hand: [],
        joinedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  console.log(`  ✅ Bot claimed seat ${seat} as "${botName}" (uid: ${botUid})`);
}

async function botPassRound1(gameId, seat) {
  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new Error("Game missing");
    const g = snap.data();

    if (g.phase !== "bidding_round_1" || g.turn !== seat) return;

    const passes = g.bidding?.passes ?? [];
    const nextPasses = passes.includes(seat) ? passes : [...passes, seat];

    if (nextPasses.length >= 4) {
      tx.update(gameRef, {
        phase: "bidding_round_2",
        bidding: { round: 2, passes: [], orderedUpBy: null },
        updatedAt: FieldValue.serverTimestamp(),
        turn: nextSeat(g.dealer),
      });
    } else {
      tx.update(gameRef, {
        bidding: { round: 1, passes: nextPasses, orderedUpBy: null },
        updatedAt: FieldValue.serverTimestamp(),
        turn: nextSeat(g.turn),
      });
    }
  });

  console.log(`  ↩️  [${seat}] Pass (round 1)`);
}

async function botOrderUp(gameId, seat) {
  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new Error("Game missing");
    const g = snap.data();

    if (g.phase !== "bidding_round_1" || g.turn !== seat || !g.upcard) return;

    const trump = suitOf(g.upcard);

    tx.update(gameRef, {
      status: "bidding",
      phase: "dealer_discard",
      trump,
      makerSeat: seat,
      goingAlone: null,
      partnerSeat: null,
      bidding: { round: 1, passes: g.bidding?.passes ?? [], orderedUpBy: seat },
      updatedAt: FieldValue.serverTimestamp(),
      turn: g.dealer,
    });
  });

  console.log(`  ⬆️  [${seat}] Order up`);
}

async function botCallTrump(gameId, seat, suit) {
  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new Error("Game missing");
    const g = snap.data();

    if (g.phase !== "bidding_round_2" || g.turn !== seat || !g.upcard) return;

    const forbidden = suitOf(g.upcard);
    if (suit === forbidden) return;

    let firstLead = nextSeat(g.dealer);

    tx.update(gameRef, {
      status: "playing",
      phase: "playing",
      trump: suit,
      makerSeat: seat,
      goingAlone: null,
      partnerSeat: null,
      bidding: { round: 2, passes: g.bidding?.passes ?? [], orderedUpBy: null },
      updatedAt: FieldValue.serverTimestamp(),
      turn: firstLead,
    });
  });

  console.log(`  🃏 [${seat}] Call trump: ${suit}`);
}

async function botPassRound2(gameId, seat, dealer) {
  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new Error("Game missing");
    const g = snap.data();

    if (g.phase !== "bidding_round_2" || g.turn !== seat) return;
    if (seat === g.dealer) return; // screw the dealer

    const passes = g.bidding?.passes ?? [];
    const nextPasses = passes.includes(seat) ? passes : [...passes, seat];

    if (nextPasses.length >= 3) {
      tx.update(gameRef, {
        bidding: { round: 2, passes: nextPasses, orderedUpBy: null },
        updatedAt: FieldValue.serverTimestamp(),
        turn: g.dealer,
      });
    } else {
      tx.update(gameRef, {
        bidding: { round: 2, passes: nextPasses, orderedUpBy: null },
        updatedAt: FieldValue.serverTimestamp(),
        turn: nextSeat(g.turn),
      });
    }
  });

  console.log(`  ↩️  [${seat}] Pass (round 2)`);
}

async function botDiscard(gameId, seat, botUid) {
  const gameRef = db.collection("games").doc(gameId);
  const playerRef = db
    .collection("games")
    .doc(gameId)
    .collection("players")
    .doc(botUid);

  await db.runTransaction(async (tx) => {
    const [gameSnap, playerSnap] = await Promise.all([
      tx.get(gameRef),
      tx.get(playerRef),
    ]);

    if (!gameSnap.exists || !playerSnap.exists) return;

    const g = gameSnap.data();
    const p = playerSnap.data();

    if (g.phase !== "dealer_discard" || g.turn !== seat || !g.upcard) return;

    const hand = p.hand ?? [];
    if (hand.length !== 5) return;

    const combined = [...hand, g.upcard];

    // Discard the weakest non-trump card, or weakest trump if no choice
    const trump = g.trump;
    const nonTrump = combined.filter((c) => effectiveSuit(c, trump) !== trump);
    const pool = nonTrump.length > 0 ? nonTrump : combined;

    // Sort by rank strength ascending, discard the weakest
    pool.sort((a, b) => rankStrength(a) - rankStrength(b));
    const discard = pool[0];

    const nextHand = combined.filter((_, i) => combined.indexOf(discard) !== i);
    // Handle duplicate card codes safely
    const idx = combined.indexOf(discard);
    const nextHandSafe = [...combined.slice(0, idx), ...combined.slice(idx + 1)];

    const nextKitty = [...(g.kitty ?? []), discard];

    const partner = g.goingAlone ? g.partnerSeat : null;
    let firstLead = nextSeat(g.dealer);
    if (partner && firstLead === partner) firstLead = nextSeat(firstLead);

    tx.update(playerRef, { hand: nextHandSafe, updatedAt: FieldValue.serverTimestamp() });
    tx.update(gameRef, {
      status: "playing",
      phase: "playing",
      kitty: nextKitty,
      updatedAt: FieldValue.serverTimestamp(),
      turn: firstLead,
    });
  });

  console.log(`  🗑️  [${seat}] Discard`);
}

async function botPlayCard(gameId, seat, botUid) {
  const gameRef = db.collection("games").doc(gameId);
  const playerRef = db
    .collection("games")
    .doc(gameId)
    .collection("players")
    .doc(botUid);

  await db.runTransaction(async (tx) => {
    const [gameSnap, playerSnap] = await Promise.all([
      tx.get(gameRef),
      tx.get(playerRef),
    ]);

    if (!gameSnap.exists || !playerSnap.exists) return;

    const g = gameSnap.data();
    const p = playerSnap.data();

    if (g.phase !== "playing" || g.turn !== seat) return;
    if (!g.trump) return;

    const trump = g.trump;
    const hand = p.hand ?? [];
    if (!hand.length) return;

    const trick = g.currentTrick ?? null;
    const existingCards = trick?.cards ?? {};

    if (existingCards[seat]) return; // already played

    const isNewTrick = !trick || Object.keys(existingCards).length === 0;
    const leadSeat = isNewTrick ? seat : trick.leadSeat;
    const leadSuit = isNewTrick ? null : trick.leadSuit;

    const card = pickCard(hand, trick, trump);
    if (!card) return;

    const actualLeadSuit = isNewTrick ? effectiveSuit(card, trump) : leadSuit;

    const nextHand = hand.filter((_, i) => hand.indexOf(card) !== i);
    const idx = hand.indexOf(card);
    const nextHandSafe = [...hand.slice(0, idx), ...hand.slice(idx + 1)];

    const nextCards = { ...existingCards, [seat]: card };

    const partnerSeat = g.goingAlone ? g.partnerSeat : null;
    const trickSize = partnerSeat ? 3 : 4;
    const seatsPlayed = Object.keys(nextCards).length;

    tx.update(playerRef, { hand: nextHandSafe, updatedAt: FieldValue.serverTimestamp() });

    if (seatsPlayed === trickSize) {
      const trickWinner = winnerOfTrick(nextCards, leadSeat, trump, actualLeadSuit);

      tx.update(gameRef, {
        updatedAt: FieldValue.serverTimestamp(),
        phase: "trick_complete",
        turn: trickWinner,
        currentTrick: {
          trickNumber: trick?.trickNumber ?? 1,
          leadSeat,
          leadSuit: actualLeadSuit,
          cards: nextCards,
          trickWinner,
        },
      });
    } else {
      let nextTurn = nextSeat(g.turn);
      if (partnerSeat && nextTurn === partnerSeat) nextTurn = nextSeat(nextTurn);

      tx.update(gameRef, {
        updatedAt: FieldValue.serverTimestamp(),
        currentTrick: {
          trickNumber: trick?.trickNumber ?? 1,
          leadSeat,
          leadSuit: actualLeadSuit,
          cards: nextCards,
        },
        turn: nextTurn,
      });
    }
  });

  console.log(`  🃏 [${seat}] Play card`);
}

async function botAdvanceTrick(gameId, seat) {
  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    if (!snap.exists) throw new Error("Game missing");
    const g = snap.data();

    if (g.phase !== "trick_complete" || g.turn !== seat) return;
    if (!g.trump) return;

    const trick = g.currentTrick;
    if (!trick?.trickWinner) return;

    const trickWinner = trick.trickWinner;
    const currentTrickNumber = trick.trickNumber;

    const prevTaken = g.tricksTaken ?? { NS: 0, EW: 0 };
    const winTeam = teamOf(trickWinner);
    const nextTaken = {
      NS: prevTaken.NS + (winTeam === "NS" ? 1 : 0),
      EW: prevTaken.EW + (winTeam === "EW" ? 1 : 0),
    };

    const nextWinners = [...(g.trickWinners ?? []), trickWinner];

    if (currentTrickNumber >= 5) {
      const makerSeat = g.makerSeat;
      const makerTeam = makerSeat ? teamOf(makerSeat) : null;
      const defenseTeam = makerTeam ? otherTeam(makerTeam) : null;

      const prevScore = g.score ?? { NS: 0, EW: 0 };
      const nextScore = { ...prevScore };

      if (makerTeam && defenseTeam) {
        const makerTricks = nextTaken[makerTeam];
        if (makerTricks >= 5) {
          nextScore[makerTeam] += g.goingAlone ? 4 : 2;
        } else if (makerTricks >= 3) {
          nextScore[makerTeam] += 1;
        } else {
          nextScore[defenseTeam] += 2;
        }
      }

      const gameWinner = winningTeam(nextScore, 10);
      const nextDealer = nextSeat(g.dealer);

      tx.update(gameRef, {
        updatedAt: FieldValue.serverTimestamp(),
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

      console.log(`\n  🏁 Hand over! Score — NS: ${nextScore.NS}, EW: ${nextScore.EW}`);
      if (gameWinner) {
        console.log(`  🏆 Game over — ${gameWinner} wins!\n`);
      }
    } else {
      const partnerSeat = g.goingAlone ? g.partnerSeat : null;
      let nextLead = trickWinner;
      if (partnerSeat && nextLead === partnerSeat) nextLead = nextSeat(nextLead);

      tx.update(gameRef, {
        updatedAt: FieldValue.serverTimestamp(),
        tricksTaken: nextTaken,
        trickWinners: nextWinners,
        phase: "playing",
        currentTrick: {
          trickNumber: currentTrickNumber + 1,
          leadSeat: nextLead,
          leadSuit: null,
          cards: {},
        },
        turn: nextLead,
      });

      console.log(`  ➡️  [${seat}] Advance — trick ${currentTrickNumber} → ${currentTrickNumber + 1}`);
    }
  });
}

// =============================================================================
// Bot Decision Engine
// =============================================================================

// Bots always pass in round 1 except the last player — that player orders up
// so the hand always gets played (avoids infinite pass loops in testing).
function shouldOrderUp(seat, g) {
  const passes = g.bidding?.passes ?? [];
  // Order up if 3 others have already passed (we'd be the last before dealer)
  // or if we are the dealer and it comes back to us.
  return passes.length >= 3 || seat === g.dealer;
}

async function handleGameState(gameId, g, botUidMap) {
  const phase = g.phase;
  const turn = g.turn;

  // Only act if it's a bot's turn
  if (!botSeats.includes(turn)) return;

  const botUid = botUidMap[turn];
  if (!botUid) return;

  await new Promise((r) => setTimeout(r, BOT_DELAY_MS));

  if (phase === "bidding_round_1") {
    if (shouldOrderUp(turn, g)) {
      await botOrderUp(gameId, turn);
    } else {
      await botPassRound1(gameId, turn);
    }
    return;
  }

  if (phase === "bidding_round_2") {
    if (turn === g.dealer) {
      // Screw the dealer — must pick a suit; pick the first allowed one
      const forbidden = suitOf(g.upcard);
      const suit = ["S", "H", "D", "C"].find((s) => s !== forbidden);
      await botCallTrump(gameId, turn, suit);
    } else {
      await botPassRound2(gameId, turn, g.dealer);
    }
    return;
  }

  if (phase === "dealer_discard" && turn === g.dealer && botSeats.includes(turn)) {
    await botDiscard(gameId, turn, botUid);
    return;
  }

  if (phase === "playing") {
    await botPlayCard(gameId, turn, botUid);
    return;
  }

  if (phase === "trick_complete") {
    await botAdvanceTrick(gameId, turn);
    return;
  }
}

// =============================================================================
// Seat Claiming
// =============================================================================

async function claimBotSeats(gameId) {
  const snap = await db.collection("games").doc(gameId).get();
  if (!snap.exists) {
    console.error(`❌ Game "${gameId}" not found in Firestore.`);
    process.exit(1);
  }

  const g = snap.data();
  const botUidMap = {}; // seat → uid

  for (const seat of botSeats) {
    const existing = g.seats?.[seat];

    if (existing) {
      // Seat already taken — check if it's one of our bots from a previous run
      const playerSnap = await db
        .collection("games")
        .doc(gameId)
        .collection("players")
        .doc(existing)
        .get();

      const name = playerSnap.data()?.name ?? "";
      if (name.startsWith("Bot-")) {
        console.log(`  ♻️  Reusing existing bot at seat ${seat} (uid: ${existing})`);
        botUidMap[seat] = existing;
      } else {
        console.log(`  ⚠️  Seat ${seat} is taken by a real player ("${name}") — skipping`);
      }
    } else {
      const botUid = `bot-${seat.toLowerCase()}-${Date.now()}`;
      const botName = `Bot-${seat}`;
      await claimSeat(gameId, seat, botUid, botName);
      botUidMap[seat] = botUid;
    }
  }

  return botUidMap;
}

// =============================================================================
// Main — Subscribe and React
// =============================================================================

async function main() {
  const botUidMap = await claimBotSeats(gameId);

  console.log(`\n👂 Listening for game state changes...\n`);

  let lastPhase = null;
  let lastTurn = null;
  let acting = false;

  // Firestore Admin uses onSnapshot differently — poll via a listener
  db.collection("games")
    .doc(gameId)
    .onSnapshot(async (snap) => {
      if (!snap.exists) {
        console.error("Game document deleted.");
        process.exit(0);
      }

      const g = snap.data();
      const phase = g.phase;
      const turn = g.turn;

      // Deduplicate — only react when phase or turn actually changes
      if (phase === lastPhase && turn === lastTurn) return;
      lastPhase = phase;
      lastTurn = turn;

      console.log(`📍 Phase: ${phase ?? "—"}  Turn: ${turn ?? "—"}`);

      if (acting) return; // prevent overlapping actions
      acting = true;

      try {
        await handleGameState(gameId, g, botUidMap);
      } catch (err) {
        console.error("  ❌ Bot error:", err.message);
      } finally {
        acting = false;
      }
    });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// =============================================================================
// Setup Instructions (see walkthrough below)
// =============================================================================
/**
 * SETUP STEPS:
 *
 * 1. Go to Firebase Console → Project Settings → Service Accounts
 * 2. Click "Generate new private key" → save as scripts/serviceAccount.json
 * 3. Add scripts/serviceAccount.json to your .gitignore (it's a secret!)
 * 4. npm install firebase-admin --save-dev
 * 5. Create the scripts/ directory and place this file there
 * 6. Create a game in the browser, copy the game ID from the URL
 * 7. node scripts/bot.mjs <gameId>
 */
