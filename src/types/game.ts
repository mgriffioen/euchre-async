import type { CardCode } from "../lib/cards";

export type Seat = "N" | "E" | "S" | "W";
export type Suit = "S" | "H" | "D" | "C";
export type TeamKey = "NS" | "EW";

export type GamePhase =
  | "lobby"
  | "bidding_round_1"
  | "bidding_round_2"
  | "dealer_discard"
  | "playing"
  | "trick_complete";

export type GameDoc = {
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
    trickNumber: number; // 1–5
    leadSeat: Seat;
    leadSuit: Suit | null; // effective suit of the lead card
    cards: Partial<Record<Seat, CardCode>>; // keyed by REAL seat
    // Set when all 4 cards are played; cleared when the trick is advanced.
    trickWinner?: Seat | null;
  } | null;

  tricksTaken?: { NS: number; EW: number } | null;
  trickWinners?: Seat[] | null;

  // Going alone: maker plays without their partner.
  goingAlone?: boolean | null;
  partnerSeat?: Seat | null; // the seat sitting out; null if not going alone

  winnerTeam?: TeamKey | null;
};

export type PlayerDoc = {
  uid: string;
  name?: string;
  seat?: Seat;
  joinedAt?: any;
  hand?: CardCode[];
};

// All seats in clockwise order
export const SEATS: Seat[] = ["N", "E", "S", "W"];

// All four suits
export const SUITS: Suit[] = ["S", "H", "D", "C"];
