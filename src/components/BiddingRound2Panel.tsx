import { suitSymbol } from "../lib/cards";
import type { Seat, Suit } from "../types/game";

interface Props {
  displayTurn: Seat | null;
  gameTurn: Seat;
  displayPasses: Seat[];
  isDealerStuck: boolean;
  displayDealer: Seat | null;
  gameDealer: Seat;
  mySeat: Seat | null;
  upcardSuit: Suit | null;
  round2AllowedSuits: Suit[];
  goAloneIntent: boolean;
  onGoAloneChange: (v: boolean) => void;
  onCallTrump: (suit: Suit, goingAlone: boolean) => void;
  onPass: () => void;
}

export default function BiddingRound2Panel({
  displayTurn, gameTurn, displayPasses, isDealerStuck, displayDealer, gameDealer,
  mySeat, upcardSuit, round2AllowedSuits, goAloneIntent, onGoAloneChange, onCallTrump, onPass,
}: Props) {
  const isMyTurn = !!mySeat && mySeat === gameTurn;

  return (
    <div className="g-card" style={{ marginTop: 12 }}>
      <h4 style={{ marginTop: 0 }}>Bidding (Round 2)</h4>

      <div style={{ marginBottom: 8 }}>
        <b>Current turn:</b> {displayTurn ?? gameTurn}
        {isDealerStuck ? (
          <span style={{ marginLeft: 8, color: "#b00" }}>
            ({displayDealer ?? gameDealer} dealer must choose)
          </span>
        ) : null}
        {displayPasses.length > 0 && (
          <div style={{ marginTop: 6, color: "#555", fontSize: 13 }}>
            Passed: {displayPasses.join(", ")}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 10, color: "#555" }}>
        Choose trump (cannot be the upcard suit{upcardSuit ? ` ${suitSymbol(upcardSuit)}` : ""}).
      </div>

      {isMyTurn && (
        <div style={{ marginBottom: 10 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={goAloneIntent}
              onChange={(e) => onGoAloneChange(e.target.checked)}
            />
            <span style={{ fontSize: 14 }}>Go alone (4 pts for a march)</span>
          </label>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        {round2AllowedSuits.map((suit) => (
          <button
            key={suit}
            onClick={() => onCallTrump(suit, goAloneIntent)}
            disabled={!isMyTurn}
            className="g-btn" style={{ padding: "12px 10px" }}
          >
            {suitSymbol(suit)}
          </button>
        ))}
      </div>

      {!isDealerStuck && (
        <button onClick={onPass} disabled={!isMyTurn} className="g-btn" style={{ width: "100%", marginTop: 10 }}>
          Pass
        </button>
      )}

      {isDealerStuck && (
        <div style={{ marginTop: 10, fontSize: 13, color: "#b00" }}>
          Screw the dealer: you can't pass here.
        </div>
      )}
    </div>
  );
}
