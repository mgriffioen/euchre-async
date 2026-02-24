import type { CardCode } from "./cards";

// Euchre deck: 9, T, J, Q, K, A across S/H/D/C
const RANKS = ["9", "T", "J", "Q", "K", "A"] as const;
const SUITS = ["S", "H", "D", "C"] as const;

export function createEuchreDeck(): CardCode[] {
  const deck: CardCode[] = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(`${r}${s}` as CardCode);
    }
  }
  return deck;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}