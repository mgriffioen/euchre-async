import type { Seat } from "../types/game";

interface Props {
  displayTurn: Seat | null;
  gameTurn: Seat;
  displayPasses: Seat[];
  mySeat: Seat | null;
  onOrderUp: (goingAlone: boolean) => void;
  onPass: () => void;
}

export default function BiddingRound1Panel({ displayTurn, gameTurn, displayPasses, mySeat, onOrderUp, onPass }: Props) {
  const isMyTurn = !!mySeat && mySeat === gameTurn;

  return (
    <div className="g-card" style={{ marginTop: 12 }}>
      <h4 style={{ marginTop: 0 }}>Bidding (Round 1)</h4>

      <div style={{ marginBottom: 8 }}>
        <b>Current turn:</b> {displayTurn ?? gameTurn}
        {displayPasses.length > 0 && (
          <span style={{ marginLeft: 10, color: "#555" }}>
            (passed: {displayPasses.join(", ")})
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={() => onOrderUp(false)} disabled={!isMyTurn} className="g-btn" style={{ flex: 1 }}>
          Order Up
        </button>
        <button onClick={() => onOrderUp(true)} disabled={!isMyTurn} className="g-btn" style={{ flex: 1 }}>
          Go Alone
        </button>
        <button onClick={onPass} disabled={!isMyTurn} className="g-btn" style={{ flex: 1 }}>
          Pass
        </button>
      </div>
    </div>
  );
}
