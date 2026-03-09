// Renders a single player's seat box on the table.

import Card from "./Card";
import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import type { Seat } from "../types/game";

// Card natural size: 70×100px. Scale to 0.85 → 59.5×85 display px.
const CARD_SCALE = 0.85;
const CARD_W = Math.round(70 * CARD_SCALE);  // 60px
const CARD_H = Math.round(100 * CARD_SCALE); // 85px

export default function SeatCard(props: {
  seat: Seat;
  label: string;
  isYou: boolean;
  isTurn: boolean;
  teamLabel?: string;
  isDealer: boolean;
  isSittingOut?: boolean;
  canClaim: boolean;
  playedCard?: CardCode | null;
  tricksWon?: number; // defined only during playing/trick_complete phases
  onClaim: () => void;
}) {
  const { label, isTurn, teamLabel, canClaim, playedCard, tricksWon, onClaim } = props;
  const teamIsA = teamLabel === "Team A";

  return (
    <div
      className="g-card"
      style={{
        borderColor: isTurn ? "#0a7" : undefined,
        boxShadow: isTurn ? "0 0 0 2px rgba(0,170,119,0.15)" : undefined,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "4px 6px 6px",
        gap: 4,
        minHeight: 0,
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Name + badges — always at top, centered */}
      <div style={{ textAlign: "center", lineHeight: 1.2, flexShrink: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
          {label}
        </div>
        {teamLabel && (
          <div style={{ marginTop: 2 }}>
            <span className={`g-team-badge ${teamIsA ? "g-team-a" : "g-team-b"}`}>{teamLabel}</span>
          </div>
        )}
        {props.isDealer && <span className="g-dealer-badge">Dealer</span>}
        {props.isSittingOut && <span className="g-sitting-out-badge">Sitting out</span>}
        {tricksWon !== undefined && tricksWon > 0 && (
          <div style={{ marginTop: 2, fontSize: 11, fontWeight: 700, color: "#0a7", letterSpacing: 1 }}>
            {"✓".repeat(tricksWon)}
          </div>
        )}
      </div>

      {/* Played card — fixed-size wrapper so layout matches visual size */}
      {playedCard ? (() => {
        const { rank, suit } = parseCard(playedCard);
        return (
          <div style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            minHeight: 0,
          }}>
            <div style={{
              width: CARD_W,
              height: CARD_H,
              overflow: "hidden",
              flexShrink: 0,
            }}>
              <div style={{ transform: `scale(${CARD_SCALE})`, transformOrigin: "top left" }}>
                <Card rank={rankLabel(rank)} suit={suitSymbol(suit)} selected={false} onClick={() => {}} />
              </div>
            </div>
          </div>
        );
      })() : <div style={{ flex: 1 }} />}

      {/* Claim button */}
      {canClaim && (
        <button onClick={onClaim} className="g-btn" style={{ marginTop: 4, width: "100%", flexShrink: 0 }}>
          Claim
        </button>
      )}
    </div>
  );
}
