# Async Euchre

Async Euchre is a **phone-first, browser-based multiplayer Euchre game** built with **React + TypeScript + Firebase**.

The goal is a lightweight, asynchronous experience where friends can:

- join a game via link
- claim seats at a virtual table
- take turns in real time or asynchronously
- play without everyone being online simultaneously

---

## Current Status

This project is in **active development** with the full core gameplay loop implemented:

**Lobby → Deal → Bidding → Dealer Pickup/Discard → Trick Play → Hand Score → Match Win (first to 10)**

Current work focuses on polish, guardrails, and incremental gameplay completeness.

---

## Tech Stack

- React + Vite
- TypeScript
- Firebase Authentication (Anonymous)
- Cloud Firestore (Realtime state)

---

## How It Works (High Level)

### Real Seats vs Display Seats

Firestore stores **REAL seats** as `N / E / S / W`.

The UI rotates seats so the **local player is always visually South**. This is a view-only mapping:

- ✅ Game logic always uses REAL seats
- ✅ Firestore reads/writes always use REAL seats
- ✅ Rotation only affects rendering

### Teams

Team naming is consistent for all players:

- **Team A = North/South (NS)**
- **Team B = East/West (EW)**

---

## Working Features

### Multiplayer + Lobby
- Anonymous Firebase authentication
- Game join via URL
- Realtime multiplayer sync via Firestore
- Seat claiming (N / E / S / W)
- Player subcollection: `games/{gameId}/players/{uid}`

### Deal / Hand Start
- Euchre deck generation (9–A)
- Shuffle + deal
- Private hands per player stored under each player doc
- Upcard + kitty generation
- Dealer rotation and turn assignment

### Bidding
- Round 1: order up / pass
- Round 2: choose trump (cannot be upcard suit)
- Screw-the-dealer enforced (dealer must choose if it comes back)

### Dealer Pickup / Discard
- Dealer temporarily sees 6 cards (hand + upcard)
- Dealer selects a discard
- Discard moves to kitty
- Play begins automatically after discard

### Trick Play
- Turn-based play enforced
- Follow-suit enforcement (with effective suit for bowers)
- Trump + bower logic implemented
- Trick winner calculation
- Trick progression until 5 tricks complete

### Scoring + Win Condition
- End-of-hand scoring updates total score (Team A vs Team B)
- Match win condition: **first to 10**
- Finished-state guards prevent late actions after game completion
- Winner banner displayed when match ends (if enabled in UI)

### UI
- Seat-based table layout (internal N/E/S/W)
- Seats rotate so local player is always visually South
- Seat cards show:
  - player name
  - team badge
  - played cards inside seat boxes
  - turn highlighting
- Mobile-friendly layout

---

## Firestore Data Model (Simplified)

```text
games/{gameId}
  - status, phase
  - seats: { N, E, S, W }
  - dealer, turn
  - bidding state
  - upcard, kitty, trump, makerSeat
  - trick state (currentTrick, tricksTaken, trickWinners)
  - score
  - winnerTeam (when finished)

games/{gameId}/players/{uid}
  - name
  - seat
  - hand (private to that player via rules)