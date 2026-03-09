// Renders a single player's seat box on the table. Receives the DISPLAY seat
// position for layout purposes, but all game logic uses REAL seats externally.

import Card from "./Card";
import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import type { Seat } from "../types/game";

export default function SeatCard(props: {
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
      className="g-card"
      style={{
        borderColor: isTurn ? "#0a7" : undefined,
        boxShadow: isTurn ? "0 0 0 2px rgba(0,170,119,0.15)" : undefined,
        display: "flex",
        flexDirection: "column",
        paddingTop: 6,
        paddingBottom: 10,
        minHeight: 0,
        height: "100%",
      }}
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
                <div style={{ transform: "scale(0.75)", transformOrigin: "center" }}>
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
            <span className="g-dealer-badge">Dealer</span>
          ) : null}

          {props.isSittingOut ? (
            <span className="g-sitting-out-badge">Sitting out</span>
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
