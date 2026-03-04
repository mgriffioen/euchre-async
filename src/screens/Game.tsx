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
import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import { createEuchreDeck, shuffle } from "../lib/deal";
import CardThemePicker from "../components/CardThemePicker";
import { useCardTheme } from "../components/CardThemeContext";

// =============================================================================
// Types & Constants
// =============================================================================

type Seat = "N" | "E" | "S" | "W";
type Suit = "S" | "H" | "D" | "C";
type TeamKey = "NS" | "EW";

type GamePhase =
  | "lobby"
  | "bidding_round_1"
  | "bidding_round_2"
  | "dealer_discard"
  | "playing"
  | "trick_complete";

type GameDoc = {
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

type PlayerDoc = {
  uid: string;
  name?: string;
  seat?: Seat;
  joinedAt?: any;
  hand?: CardCode[];
};

// All seats in clockwise order
const SEATS: Seat[] = ["N", "E", "S", "W"];

// All four suits
const SUITS: Suit[] = ["S", "H", "D", "C"];

// =============================================================================
// Styles
// =============================================================================
// Defined near the top so they're available to all components in this file.

// Styles that need dark-mode awareness are expressed as CSS classes
// injected once at module level. Inline style objects are used only for
// layout/spacing values that never change between color schemes.
const DARK_MODE_CSS = `
  .g-alert {
    padding: 12px;
    background: #fff3cd;
    border: 1px solid #ffecb5;
    border-radius: 10px;
    margin-bottom: 12px;
    color: #664d03;
  }
  .g-card {
    padding: 12px;
    border: 1px solid #ddd;
    border-radius: 12px;
    background: white;
    margin-bottom: 12px;
    color: inherit;
  }
  .g-btn {
    padding: 10px 14px;
    border-radius: 10px;
    border: 1px solid #ccc;
    background: white;
    cursor: pointer;
    color: #111;
    font-size: 14px;
  }
  .g-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }
  /* Turn banner */
  .g-banner {
    padding: 12px;
    border-radius: 12px;
    margin-bottom: 12px;
    font-weight: 600;
    background: #f8f9fa;
    border: 1px solid #ddd;
    color: #111;
  }
  .g-banner.my-turn {
    background: #d1e7dd;
    border-color: #badbcc;
    color: #0a3622;
  }

  /* Score pill */
  .g-score-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid #ddd;
    background: #fafafa;
    font-size: 18px;
    font-weight: 800;
    line-height: 1;
    white-space: nowrap;
    color: #111;
  }
  .g-score-label {
    font-size: 12px;
    font-weight: 700;
    color: #666;
  }
  .g-score-sep {
    color: #bbb;
    font-weight: 700;
  }

  /* Winner banner */
  .g-winner {
    margin-top: 10px;
    margin-bottom: 12px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 2px solid #111;
    background: #fff;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    color: #111;
  }

  /* Copy button */
  .g-copy-btn {
    padding: 6px 10px;
    border-radius: 8px;
    background: #d1e7dd;
    border: 1px solid #badbcc;
    cursor: pointer;
    color: #0a3622;
  }

  /* Team badge in seat card */
  .g-team-badge {
    font-size: 12px;
    padding: 2px 8px;
    margin-top: 3px;
    border-radius: 8px;
    display: inline-block;
    white-space: nowrap;
    line-height: 1.4;
  }
  .g-team-a {
    background: rgba(0,128,0,0.12);
    border: 1px solid rgba(0,128,0,0.3);
    color: #1a5c1a;
  }
  .g-team-b {
    background: rgba(0,80,200,0.1);
    border: 1px solid rgba(0,80,200,0.25);
    color: #0a2e6e;
  }

  /* TrickMeter dots */
  .g-dot {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 1px solid #bbb;
    background: transparent;
  }
  .g-dot.filled {
    background: #333;
    border-color: #333;
  }

  /* Trump indicator */
  .g-trump {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px 6px 10px;
    border-radius: 10px;
    border: 1px solid #ccc;
    background: white;
    font-size: 15px;
    font-weight: 700;
    margin-bottom: 10px;
    box-shadow: 0 2px 6px rgba(0,0,0,0.10);
    color: #111;
    transition: all 0.15s ease;
  }
  .g-trump-suit {
    font-size: 26px;
    line-height: 1;
  }
  .g-trump-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.55;
  }
  .g-trump.theme-eightbit {
    background: #0d0d0d;
    border: 3px solid #00ff41;
    border-radius: 0;
    box-shadow: 3px 3px 0 #00ff41;
    font-family: "Courier New", Courier, monospace;
    color: #00ff41;
  }
  .g-trump.theme-eightbit .g-trump-suit {
    text-shadow: 0 0 8px currentColor;
  }
  .g-trump.theme-eightbit .g-trump-label {
    opacity: 0.7;
    letter-spacing: 0.12em;
  }
  .g-trump.theme-oldwest {
    background: linear-gradient(145deg, #f5e6c8 0%, #e8d49a 100%);
    border: 2px solid #8b5c2a;
    border-radius: 4px;
    box-shadow: 2px 3px 8px rgba(92,46,0,0.35);
    font-family: "Palatino Linotype", Palatino, "Book Antiqua", serif;
    color: #1a0a00;
  }
  .g-trump.theme-oldwest .g-trump-label {
    opacity: 0.6;
    letter-spacing: 0.1em;
  }

  @media (prefers-color-scheme: dark) {
    .g-trump {
      background: #1e1e1e;
      border-color: #444;
      color: #eee;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    }
    .g-trump.theme-eightbit {
      background: #0d0d0d;
      border-color: #00ff41;
      color: #00ff41;
      box-shadow: 3px 3px 0 #00ff41;
    }
    .g-trump.theme-oldwest {
      background: linear-gradient(145deg, #f5e6c8 0%, #e8d49a 100%);
      border-color: #8b5c2a;
      color: #1a0a00;
    }
  }

  @media (prefers-color-scheme: dark) {
    .g-alert {
      background: #3a2e00;
      border-color: #7a6200;
      color: #ffd966;
    }
    .g-card {
      background: #1e1e1e;
      border-color: #444;
      color: #eee;
    }
    .g-btn {
      background: #2a2a2a;
      border-color: #555;
      color: #eee;
    }
    .g-banner {
      background: #1e1e1e;
      border-color: #444;
      color: #ccc;
    }
    .g-banner.my-turn {
      background: #0d2b1e;
      border-color: #0a7;
      color: #6ee7b7;
    }
    .g-score-pill {
      background: #1e1e1e;
      border-color: #444;
      color: #eee;
    }
    .g-score-label {
      color: #999;
    }
    .g-score-sep {
      color: #555;
    }
    .g-winner {
      background: #1e1e1e;
      border-color: #aaa;
      color: #eee;
    }
    .g-copy-btn {
      background: #0d2b1e;
      border-color: #0a7;
      color: #6ee7b7;
    }
    .g-team-a {
      background: rgba(0,170,100,0.15);
      border-color: rgba(0,170,100,0.35);
      color: #6ee7b7;
    }
    .g-team-b {
      background: rgba(80,140,255,0.12);
      border-color: rgba(80,140,255,0.3);
      color: #93c5fd;
    }
    .g-dot {
      border-color: #555;
    }
    .g-dot.filled {
      background: #ccc;
      border-color: #ccc;
    }
  }
`;

// Inject the CSS once at module evaluation time.
if (typeof document !== "undefined") {
  const styleId = "euchre-dark-mode-styles";
  if (!document.getElementById(styleId)) {
    const el = document.createElement("style");
    el.id = styleId;
    el.textContent = DARK_MODE_CSS;
    document.head.appendChild(el);
  }
}



const tableStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr 1fr",
  gridTemplateRows: "auto auto auto",
  gap: 10,
  alignItems: "stretch",
  justifyItems: "stretch",
};

// =============================================================================
// Pure Helpers — Team & Seat
// =============================================================================

// Returns which team a given real seat belongs to.
function teamKeyForSeat(seat: Seat): TeamKey {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

// Alias used in game-logic contexts (equivalent to teamKeyForSeat).
function teamOf(seat: Seat): TeamKey {
  return seat === "N" || seat === "S" ? "NS" : "EW";
}

function otherTeam(team: TeamKey): TeamKey {
  return team === "NS" ? "EW" : "NS";
}


// Returns the seat directly across the table (the partner seat).
function partnerOf(seat: Seat): Seat {
  if (seat === "N") return "S";
  if (seat === "S") return "N";
  if (seat === "E") return "W";
  return "E"; // W
}
// Returns the winning team if either team has reached the target score, or null if the game is ongoing.
function winningTeam(score: { NS: number; EW: number }, target = 10): TeamKey | null {
  if (score.NS >= target) return "NS";
  if (score.EW >= target) return "EW";
  return null;
}

// Returns the next seat clockwise from the given seat.
function nextSeat(seat: Seat): Seat {
  const i = SEATS.indexOf(seat);
  return SEATS[(i + 1) % SEATS.length];
}

// =============================================================================
// Pure Helpers — Seat Rotation
// =============================================================================
// Firestore always stores REAL seats (N/E/S/W).
// The UI rotates the table so the local player always appears at the South position.
// All game logic and Firestore reads/writes use REAL seats; rotation is view-only.

function seatIndex(seat: Seat): number {
  return SEATS.indexOf(seat); // N=0, E=1, S=2, W=3
}

// Calculates how many positions to rotate so that `my` seat lands at South (index 2).
function rotationOffsetToMakeMySeatSouth(my: Seat): number {
  const southIdx = seatIndex("S"); // 2
  const myIdx = seatIndex(my);
  return (southIdx - myIdx + 4) % 4;
}

// Converts a real seat to the display seat the local player sees.
function realToDisplaySeat(real: Seat, my: Seat): Seat {
  const off = rotationOffsetToMakeMySeatSouth(my);
  return SEATS[(seatIndex(real) + off) % 4];
}

// =============================================================================
// Pure Helpers — Euchre Card Logic
// =============================================================================

// Extracts the suit character from a card code (e.g. "JS" → "S").
function suitCharFromCard(code: CardCode): Suit {
  return code[1] as Suit;
}

// Returns the suit of the left bower for a given trump suit.
// The left bower is the Jack of the same-color suit as trump.
function leftBowerSuit(trump: Suit): Suit {
  if (trump === "H") return "D";
  if (trump === "D") return "H";
  if (trump === "S") return "C";
  return "S"; // trump === "C"
}

function isJack(code: CardCode): boolean {
  const { rank } = parseCard(code);
  return rankLabel(rank) === "J";
}

// Returns true if the card is the right bower (Jack of trump suit).
function isRightBower(code: CardCode, trump: Suit): boolean {
  return isJack(code) && suitCharFromCard(code) === trump;
}

// Returns true if the card is the left bower (Jack of the same-color suit as trump).
function isLeftBower(code: CardCode, trump: Suit): boolean {
  return isJack(code) && suitCharFromCard(code) === leftBowerSuit(trump);
}

// Returns the effective suit of a card, accounting for the left bower counting as trump.
function effectiveSuit(code: CardCode, trump: Suit): Suit {
  const s = suitCharFromCard(code);
  if (isJack(code) && s === leftBowerSuit(trump)) return trump;
  return s;
}

// Returns true if the hand contains at least one card of the given effective suit.
function hasSuitInHand(hand: CardCode[], suit: Suit, trump: Suit): boolean {
  return hand.some((c) => effectiveSuit(c, trump) === suit);
}

// Returns a new hand array with the first occurrence of `code` removed.
function removeOneCard(hand: CardCode[], code: CardCode): CardCode[] {
  const idx = hand.indexOf(code);
  if (idx === -1) return hand;
  const next = hand.slice();
  next.splice(idx, 1);
  return next;
}

// Returns a numeric rank strength for a card (used as a tiebreaker within suits).
function rankStrength(code: CardCode): number {
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
function trickStrength(code: CardCode, leadSuit: Suit, trump: Suit): number {
  if (isRightBower(code, trump)) return 200;
  if (isLeftBower(code, trump)) return 199;

  const eff = effectiveSuit(code, trump);
  const r = rankStrength(code);

  if (eff === trump) return 150 + r;
  if (eff === leadSuit) return 100 + r;
  return r; // off-suit card; can only win if it's the only card played
}

// Determines which seat won the trick based on card strengths.
function winnerOfTrick(
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

// =============================================================================
// Sub-component — TrickMeter
// =============================================================================
// Displays a dot-based tricks-taken tracker for both teams during the playing phase.

function TrickMeter(props: {
  aLabel: string;
  aCount: number;
  bLabel: string;
  bCount: number;
}) {
  const { aLabel, aCount, bLabel, bCount } = props;

  // Renders a row of 5 dots, filled up to `filled`.
  const DotRow = ({ filled }: { filled: number }) => (
    <div style={{ display: "flex", gap: 6 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className={`g-dot${i < filled ? " filled" : ""}`} />
      ))}
    </div>
  );

  return (
    <div className="g-card" style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 10 }}>Tricks This Hand</div>

      <div style={{ display: "grid", gridTemplateColumns: "72px 1fr 28px", gap: 10, rowGap: 10 }}>
        <div style={{ fontWeight: 700 }}>{aLabel}</div>
        <DotRow filled={aCount} />
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{aCount}</div>

        <div style={{ fontWeight: 700 }}>{bLabel}</div>
        <DotRow filled={bCount} />
        <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{bCount}</div>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-component — SeatCard
// =============================================================================
// Renders a single player's seat box on the table. Receives the DISPLAY seat
// position for layout purposes, but all game logic uses REAL seats externally.

function SeatCard(props: {
  seat: Seat; // display seat (used for card/text layout direction)
  label: string;
  isYou: boolean;
  isTurn: boolean;
  teamLabel?: string;
  isDealer: boolean;
  isSittingOut?: boolean; // true when this player is sitting out a going-alone hand
  canClaim: boolean;
  playedCard?: CardCode | null;
  onClaim: () => void;
}) {
  const { seat, label, isTurn, teamLabel, canClaim, playedCard, onClaim } = props;

  // Layout varies by display position so the played card always faces the center of the table.
  // E: card left of text | W: card right of text | N: card below text | S: card above text
  const layout =
    seat === "E"
      ? { dir: "row" as const, textAlign: "left" as const, textItems: "flex-start" as const }
      : seat === "W"
      ? { dir: "row-reverse" as const, textAlign: "right" as const, textItems: "flex-end" as const }
      : seat === "N"
      ? { dir: "column-reverse" as const, textAlign: "center" as const, textItems: "center" as const }
      : { dir: "column" as const, textAlign: "center" as const, textItems: "center" as const }; // S

  const teamIsA = teamLabel === "Team A";

  return (
    <div
      className="g-card" style={{ borderColor: isTurn ? "#0a7" : undefined,
        boxShadow: isTurn ? "0 0 0 2px rgba(0,170,119,0.15)" : undefined,
        display: "flex",
        flexDirection: "column",
        paddingTop: 6,
        paddingBottom: 10,
        minHeight: 130 }}
    >
      {/* Player name, team badge, dealer badge, and played card */}
      <div
        style={{
          display: "flex",
          flexDirection: layout.dir,
          alignItems: "center",
          justifyContent: "center",
          gap: 10,
          flex: "1 1 auto",
        }}
      >
        {/* Played card (shown during trick play) */}
        {playedCard ? (
          <div style={{ flex: "0 0 auto" }}>
            {(() => {
              const { rank, suit } = parseCard(playedCard);
              return (
                <div style={{ transform: "scale(0.92)", transformOrigin: "center" }}>
                  <Card
                    rank={rankLabel(rank)}
                    suit={suitSymbol(suit)}
                    selected={false}
                    onClick={() => {}}
                  />
                </div>
              );
            })()}
          </div>
        ) : null}

        {/* Player name and team/dealer badges */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: layout.textItems,
            textAlign: layout.textAlign,
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 18, lineHeight: 1.15 }}>{label}</div>

          {teamLabel ? (
            <div style={{ marginTop: 6 }}>
              <span className={`g-team-badge ${teamIsA ? "g-team-a" : "g-team-b"}`}>
                {teamLabel}
              </span>
            </div>
          ) : null}

          {props.isDealer ? (
            <span
              style={{
                fontSize: 12,
                padding: "3px 8px",
                marginTop: "3px",
                borderRadius: 8,
                border: "1px solid #d9d9d9",
                display: "inline-block",
                whiteSpace: "nowrap",
                lineHeight: 1.2,
                background: "rgba(0,0,0,0.06)",
                color: "#333",
                fontWeight: 700,
              }}
            >
              Dealer
            </span>
          ) : null}

          {props.isSittingOut ? (
            <span
              style={{
                fontSize: 12,
                padding: "3px 8px",
                marginTop: "3px",
                borderRadius: 8,
                border: "1px solid #f5c6cb",
                display: "inline-block",
                whiteSpace: "nowrap",
                lineHeight: 1.2,
                background: "rgba(220,53,69,0.08)",
                color: "#842029",
                fontWeight: 600,
              }}
            >
              Sitting out
            </span>
          ) : null}
        </div>
      </div>

      {/* Claim button — only shown for open seats before the local player has sat down */}
      {canClaim ? (
        <button onClick={onClaim} className="g-btn" style={{ marginTop: 10, width: "100%" }}>
          Claim
        </button>
      ) : null}
    </div>
  );
}

// =============================================================================
// Trump Indicator
// =============================================================================

function TrumpIndicator({ suit }: { suit: string }) {
  const { theme } = useCardTheme();
  const isRed = suit === "\u2665" || suit === "\u2666";

  const suitColor =
    theme === "eightbit"
      ? isRed ? "#ff2a6d" : "#00ff41"
      : theme === "oldwest"
      ? isRed ? "#8b1a1a" : "#1a0a00"
      : isRed ? "#d22" : "#111";

  return (
    <div className={`g-trump theme-${theme}`}>
      <div className="g-trump-label">Trump</div>
      <span className="g-trump-suit" style={{ color: suitColor }}>
        {suit}
      </span>
    </div>
  );
}

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
  // Orders up the upcard in round 1. If goingAlone is true, stores the partner seat
  // so they sit out the hand. The dealer still discards before play begins.
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
        <CardThemePicker  />
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
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, marginBottom: 12 }}>
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
          <div style={tableStyle}>
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
          <div
            style={{
              display: "flex",
              gap: 10,
              overflowX: "auto",
              overflowY: "visible", // allows cards to lift upward when selected
              paddingTop: 10,
              paddingBottom: 8,
            }}
          >
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
