# Async Euchre

Async Euchre is a **phone-first, browser-based multiplayer Euchre game** built with React and Firebase.

The goal is a lightweight, asynchronous experience where friends can:

* join a game via link
* claim seats at a virtual table
* take turns in real time or asynchronously
* play without everyone being online simultaneously

---

## Project Status

This project is in **active development**.

Core game flow now exists end-to-end:

* Lobby → Deal → Bidding → Dealer Pickup → Trick Play → Hand End

Current focus areas:

* UI polish and layout consistency
* Safe component refactors inside `Game.tsx`
* Preparing for score progression across multiple hands

---

## Tech Stack

* **React + Vite**
* **TypeScript**
* **Firebase Authentication (Anonymous)**
* **Cloud Firestore (Realtime state)**
* Mobile-first responsive UI

---

## Architecture Overview

### Firestore Model (High Level)

```
games/{gameId}
  - shared public game state
  - seats, dealer, turn, phase
  - bidding state
  - trick state
  - scoring

games/{gameId}/players/{uid}
  - player metadata
  - private hand (only visible to owner)
```

### Key Design Principles

* Firestore stores **REAL seats**: `N / E / S / W`
* UI rotates seats so the **local player always displays as South**
* Game logic always runs against real seats
* UI mapping handles display rotation only

---

## Current Gameplay Features

### Core Multiplayer

* Anonymous Firebase authentication
* Game creation + join via URL
* Realtime multiplayer sync via Firestore
* Seat claiming (N / E / S / W)
* Player subcollection (`players/{uid}`)

---

### Hand Flow

* Start Hand / Deal flow
* Euchre deck generation (9–A)
* Random shuffle + clockwise deal
* Private hands per player
* Upcard generation
* Dealer rotation per hand

---

### Bidding System

Implemented phases:

1. `bidding_round_1`

   * Order up or pass
2. `dealer_discard`

   * Dealer picks up upcard and discards
3. `bidding_round_2`

   * Call alternate trump
   * Screw-the-dealer enforced

---

### Trick Play

* Turn-based play enforced
* Follow-suit rules enforced
* Trump + bower logic implemented
* Trick winner calculation
* Trick tracking per hand
* Automatic transition to next trick
* Hand resets after 5 tricks (temporary lobby reset)

---

### Table & UI System

#### Seat Rotation

* Local player always shown as **South**
* Internal game logic remains seat-agnostic

#### Team System

* Team A = North / South
* Team B = East / West
* Labels remain consistent across viewers

#### Seat Cards

* Player name display
* Team badge coloring
* Turn highlighting (green border)
* Played cards rendered inside seat boxes

Played card alignment:

* N → bottom (toward center)
* E → left
* S → top
* W → right

---

### Dealer Pickup / Discard

* Dealer temporarily sees 6 cards (hand + upcard)
* Select card to discard
* Discard moves to kitty
* Play begins automatically after discard

---

## 📂 Important File

### `src/screens/Game.tsx`

Currently the main gameplay screen.

Responsibilities include:

* Firestore subscriptions
* Turn logic
* Bidding actions
* Dealer discard flow
* Trick resolution
* UI rendering

 Planned work:

* Incremental extraction of UI components
* Maintain gameplay logic stability during refactors

---

## Next Milestones

### UI / UX

* Improve seat layout consistency
* Reduce duplication in seat rendering
* Cleaner component structure
* Better visual trick center feedback

### Gameplay

* Persistent scoring between hands
* End-of-hand scoring rules (makers / euchres)
* Game-end conditions

### Technical

* Break `Game.tsx` into:

  * SeatTable
  * HandRow
  * BiddingPanel
  * TurnBanner
* Preserve existing Firestore schema

---

## Development Philosophy

This project prioritizes:

* Small, safe refactors
* Minimal regressions
* Firestore-safe transactions
* UI improvements without touching core game rules

Gameplay logic should remain stable while UI evolves.

---

## Long-Term Vision

Async Euchre aims to be:

* lightweight
* mobile-friendly
* low-friction for friend groups
* asynchronous by design

No accounts, no downloads — just share a link and play.

---
