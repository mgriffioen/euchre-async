import Card from "./Card";
import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import type { GamePhase, Suit } from "../types/game";

interface Props {
  displayHand: CardCode[];
  phase: GamePhase | undefined;
  isMyTurn: boolean;
  mustFollow: Suit | null;
  playableSet: Set<CardCode> | null;
  selectedCard: number | null;
  onSelect: (i: number | null) => void;
  onPlay: (code: CardCode) => void;
}

export default function PlayerHand({
  displayHand, phase, isMyTurn, mustFollow, playableSet, selectedCard, onSelect, onPlay,
}: Props) {
  const isPlayingTurn = phase === "playing" && isMyTurn;

  return (
    <>
      <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.5, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>Your hand</div>
      <div className="g-hand">
        {displayHand.map((code, i) => {
          const { rank, suit } = parseCard(code);
          const isPlayable = !isPlayingTurn || !playableSet ? true : playableSet.has(code);
          const isInteractive = phase !== "trick_complete";

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
                  if (phase === "dealer_discard") {
                    onSelect(selectedCard === i ? null : i);
                    return;
                  }
                  if (phase === "playing" && isMyTurn) {
                    onPlay(code);
                    return;
                  }
                  onSelect(selectedCard === i ? null : i);
                }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
