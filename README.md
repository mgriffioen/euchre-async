# Async Euchre

A **phone-first, browser-based multiplayer Euchre game** built with React, TypeScript, and Firebase.

Friends can join a game via shared link, claim seats at a virtual table, and play turns in real time or asynchronously — no one needs to be online at the same time.

🔗 **Live:** [euchre-async.vercel.app](https://euchre-async.vercel.app)

---

## Tech Stack

- **React + Vite** — UI and build tooling
- **TypeScript** — end-to-end type safety
- **Firebase Anonymous Auth** — frictionless identity (no sign-up required)
- **Cloud Firestore** — real-time shared game state and private per-player hands

---

## How It Works

### Game Flow

```
Lobby → Deal → Bidding → Dealer Pickup/Discard → Trick Play → Hand Score → Match Win
```

The match ends when a team reaches **10 points**. The dealer rotates each hand.

### Seat Model — Real vs. Display

Firestore always stores seats as real compass positions: `N / E / S / W`.

The UI rotates the table so the **local player always appears at the South position**. This rotation is purely cosmetic:

- Game logic always uses real seats
- Firestore reads and writes always use real seats
- Rotation only affects what gets rendered on screen

### Teams

Team assignments are consistent for all players regardless of perspective:

- **Team A = North / South (NS)**
- **Team B = East / West (EW)**

---

## Features

### Lobby & Multiplayer
- Anonymous Firebase authentication — no account needed
- Join any game via a shareable URL
- Claim one of four seats (N / E / S / W)
- Real-time state sync via Firestore

### Dealing
- Standard Euchre deck (9 through Ace, four suits)
- Shuffle and deal 5 cards to each player
- Upcard flipped to start bidding; remainder goes to kitty
- Deal order is clockwise starting left of the dealer

### Bidding
- **Round 1** — each player in turn may order up the upcard or pass
- **Round 2** — each player may call any suit except the upcard's suit, or pass
- **Screw-the-dealer** enforced: the dealer must call trump if everyone else passes in round 2

### Dealer Pickup & Discard
- When ordered up, the dealer temporarily sees 6 cards (their hand + the upcard)
- Dealer taps a card to select it, then confirms the discard
- The upcard replaces the discarded card; play begins immediately after

### Trick Play
- Strict turn enforcement — only the active player can play a card
- **Follow-suit enforcement** with correct effective-suit handling for bowers
- Right bower (Jack of trump) and left bower (Jack of same-color suit) ranked correctly
- Trick winner leads the next trick
- 5 tricks complete a hand

### Scoring
- **March (5 tricks):** making team scores 2 points
- **Made it (3–4 tricks):** making team scores 1 point
- **Euchred (fewer than 3 tricks):** defending team scores 2 points
- Scores persist across hands; first team to **10 points** wins

### UI
- Phone-first layout with a 3×3 grid table (seats at N/S/E/W, center empty)
- Seat cards display player name, team badge, dealer badge, and the card played this trick
- Active turn is highlighted in green across seat cards and the turn banner
- Cards in hand that cannot legally be played are dimmed and non-interactive
- Trick progress tracker (dot meter) shown during play
- Winner banner displayed when the match ends

---

## Firestore Data Model

```
games/{gameId}
  status          — "lobby" | "bidding" | "playing" | "finished"
  phase           — "lobby" | "bidding_round_1" | "bidding_round_2" | "dealer_discard" | "playing"
  seats           — { N, E, S, W }  →  uid | null
  dealer          — real seat of the current dealer
  turn            — real seat of the player whose turn it is
  handNumber      — increments each hand
  upcard          — card code, null after play begins
  kitty           — remaining cards not dealt
  trump           — chosen trump suit
  makerSeat       — real seat of the player who called trump
  bidding         — { round, passes[], orderedUpBy }
  currentTrick    — { trickNumber, leadSeat, leadSuit, cards: { seat → card } }
  tricksTaken     — { NS, EW }
  trickWinners    — ordered list of real seats that won each trick
  score           — { NS, EW }
  winnerTeam      — "NS" | "EW" | null

games/{gameId}/players/{uid}
  uid             — Firebase anonymous user ID
  name            — display name entered by the player
  seat            — real seat claimed by this player
  hand            — private hand (Firestore rules restrict reads to the owning player)
  joinedAt        — server timestamp
```

---

## Project Structure

```
src/
  Game.tsx          — main game screen (state, actions, render)
  components/
    Card.tsx        — playing card component
  lib/
    cards.ts        — card parsing, rank/suit labels
    deal.ts         — deck creation and shuffle
  firebase.ts       — Firestore client setup
  auth.ts           — anonymous auth helper
```

---

## Local Development

```bash
npm install
npm run dev
```

Requires a Firebase project with Firestore and Anonymous Auth enabled. Copy your Firebase config into `firebase.ts`.