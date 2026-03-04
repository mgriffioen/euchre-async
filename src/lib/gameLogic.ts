import { parseCard, rankLabel } from "./cards";
import type { CardCode } from "./cards";
import type { Seat, Suit, TeamKey } from "../types/game";
import { SEATS } from "../types/game";

// =============================================================================
// Team & Seat Helpers
// =============================================================================

// Returns which team a given real seat belongs to.
export function teamKeyForSeat(seat: Seat): TeamKey {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

// Alias used in game-logic contexts (equivalent to teamKeyForSeat).
export function teamOf(seat: Seat): TeamKey {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

export function otherTeam(team: TeamKey): TeamKey {
  return team === "NS" ? "EW" : "NS";
}

// Returns the seat directly across the table (the partner seat).
export function partnerOf(seat: Seat): Seat {
  if (seat === "N") return "S";
  if (seat === "S") return "N";
  if (seat === "E") return "W";
  return "E"; // W
}

// Returns the winning team if either team has reached the target score, or null if the game is ongoing.
export function winningTeam(score: { NS: number; EW: number }, target = 10): TeamKey | null {
  if (score.NS >= target) return "NS";
  if (score.EW >= target) return "EW";
  return null;
}

// Returns the next seat clockwise from the given seat.
export function nextSeat(seat: Seat): Seat {
  const i = SEATS.indexOf(seat);
  return SEATS[(i + 1) % SEATS.length];
}

// =============================================================================
// Seat Rotation Helpers
// =============================================================================
// Firestore always stores REAL seats (N/E/S/W).
// The UI rotates the table so the local player always appears at the South position.
// All game logic and Firestore reads/writes use REAL seats; rotation is view-only.

export function seatIndex(seat: Seat): number {
  return SEATS.indexOf(seat); // N=0, E=1, S=2, W=3
}

// Calculates how many positions to rotate so that `my` seat lands at South (index 2).
export function rotationOffsetToMakeMySeatSouth(my: Seat): number {
  const southIdx = seatIndex("S"); // 2
  const myIdx = seatIndex(my);
  return (southIdx - myIdx + 4) % 4;
}

// Converts a real seat to the display seat the local player sees.
export function realToDisplaySeat(real: Seat, my: Seat): Seat {
  const off = rotationOffsetToMakeMySeatSouth(my);
  return SEATS[(seatIndex(real) + off) % 4];
}

// =============================================================================
// Euchre Card Logic
// =============================================================================

// Extracts the suit character from a card code (e.g. "JS" → "S").
export function suitCharFromCard(code: CardCode): Suit {
  return code[1] as Suit;
}

// Returns the suit of the left bower for a given trump suit.
// The left bower is the Jack of the same-color suit as trump.
export function leftBowerSuit(trump: Suit): Suit {
  if (trump === "H") return "D";
  if (trump === "D") return "H";
  if (trump === "S") return "C";
  return "S"; // trump === "C"
}

export function isJack(code: CardCode): boolean {
  const { rank } = parseCard(code);
  return rankLabel(rank) === "J";
}

// Returns true if the card is the right bower (Jack of trump suit).
export function isRightBower(code: CardCode, trump: Suit): boolean {
  return isJack(code) && suitCharFromCard(code) === trump;
}

// Returns true if the card is the left bower (Jack of the same-color suit as trump).
export function isLeftBower(code: CardCode, trump: Suit): boolean {
  return isJack(code) && suitCharFromCard(code) === leftBowerSuit(trump);
}

// Returns the effective suit of a card, accounting for the left bower counting as trump.
export function effectiveSuit(code: CardCode, trump: Suit): Suit {
  const s = suitCharFromCard(code);
  if (isJack(code) && s === leftBowerSuit(trump)) return trump;
  return s;
}

// Returns true if the hand contains at least one card of the given effective suit.
export function hasSuitInHand(hand: CardCode[], suit: Suit, trump: Suit): boolean {
  return hand.some((c) => effectiveSuit(c, trump) === suit);
}

// Returns a new hand array with the first occurrence of `code` removed.
export function removeOneCard(hand: CardCode[], code: CardCode): CardCode[] {
  const idx = hand.indexOf(code);
  if (idx === -1) return hand;
  const next = hand.slice();
  next.splice(idx, 1);
  return next;
}

// Returns a numeric rank strength for a card (used as a tiebreaker within suits).
export function rankStrength(code: CardCode): number {
  const { rank } = parseCard(code);
  const r = String(rank);

  if (r === "9") return 1;
  if (r === "10" || r === "T") return 2;
  if (r === "J") return 3;
  if (r === "Q") return 4;
  if (r === "K") return 5;
  if (r === "A") return 6;

  const n = Number(r);
  return Number.isFinite(n) ? n : 0;
}

// Returns a trick-winning strength score for a card.
// Right bower (200) > left bower (199) > trump (150+rank) > lead suit (100+rank) > off-suit (rank only).
export function trickStrength(code: CardCode, leadSuit: Suit, trump: Suit): number {
  if (isRightBower(code, trump)) return 200;
  if (isLeftBower(code, trump)) return 199;

  const eff = effectiveSuit(code, trump);
  const r = rankStrength(code);

  if (eff === trump) return 150 + r;
  if (eff === leadSuit) return 100 + r;
  return r; // off-suit card; can only win if it's the only card played
}

// Determines which seat won the trick based on card strengths.
export function winnerOfTrick(
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
