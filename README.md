# Async Euchre

Async Euchre is a phone-first, browser-based multiplayer Euchre game built with React and Firebase.

The goal is a lightweight, asynchronous experience where friends can join a game link, take turns, and play without needing to be online at the same time.

---

## Current Status

This project is in active development.

### Working Features

- Anonymous Firebase authentication
- Game creation and join via URL
- Seat claiming (N / E / S / W)
- Realtime multiplayer sync via Firestore
- Player subcollection (`players/{uid}`)
- Start Hand / Deal flow
- Euchre deck generation (9–A)
- Random shuffle + deal
- Private hands per player
- Upcard generation
- Mobile-first UI
- Classic playing card components

---

## Tech Stack

- React + Vite
- TypeScript
- Firebase Authentication (Anonymous)
- Cloud Firestore (Realtime database)

---