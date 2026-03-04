import TrumpIndicator from "./TrumpIndicator";
import { suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import type { Seat, Suit } from "../types/game";

interface Props {
  trump: Suit | null | undefined;
  mySeat: Seat | null;
  gameDealer: Seat;
  displayDealer: Seat | null;
  selectedCard: number | null;
  displayHand: CardCode[];
  setErr: (e: string | null) => void;
  onDiscard: (card: CardCode) => void;
}

export default function DealerDiscardPanel({
  trump, mySeat, gameDealer, displayDealer, selectedCard, displayHand, setErr, onDiscard,
}: Props) {
  const isDealer = mySeat === gameDealer;

  function handleDiscard() {
    if (selectedCard == null) { setErr("Select a card to discard."); return; }
    const code = displayHand[selectedCard];
    if (!code) { setErr("Select a card to discard."); return; }
    onDiscard(code);
  }

  return (
    <div className="g-card" style={{ marginTop: 12 }}>
      <h4 style={{ marginTop: 0 }}>Dealer: Pick up & Discard</h4>

      {trump && (
        <div style={{ marginBottom: 8 }}>
          <TrumpIndicator suit={suitSymbol(trump)} />
        </div>
      )}

      {isDealer ? (
        <>
          <div style={{ marginBottom: 10, color: "#555" }}>Select a card to discard.</div>
          <button onClick={handleDiscard} className="g-btn" style={{ width: "100%" }}>
            Discard Selected Card
          </button>
        </>
      ) : (
        <div style={{ color: "#555" }}>
          Waiting for dealer ({displayDealer ?? gameDealer}) to pick up and discard…
        </div>
      )}
    </div>
  );
}
