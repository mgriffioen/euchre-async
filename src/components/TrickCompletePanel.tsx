interface Props {
  trickWinnerName: string;
  isLastTrick: boolean;
  iWonTheTrick: boolean;
  onAdvance: () => void;
}

export default function TrickCompletePanel({ trickWinnerName, isLastTrick, iWonTheTrick, onAdvance }: Props) {
  return (
    <div className="g-card" style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 8 }}>
        {iWonTheTrick ? "You won the trick! 🎉" : `${trickWinnerName} won the trick`}
      </div>

      {iWonTheTrick ? (
        <button onClick={onAdvance} className="g-btn" style={{ width: "100%" }}>
          {isLastTrick ? "Finish Hand" : "Next Trick"}
        </button>
      ) : (
        <div style={{ color: "#555" }}>Waiting for {trickWinnerName} to continue…</div>
      )}
    </div>
  );
}
