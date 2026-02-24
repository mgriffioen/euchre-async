type Props = {
  rank: string;
  suit: "♠" | "♥" | "♦" | "♣";
  selected?: boolean;
  onClick?: () => void;
};

export default function Card({ rank, suit, selected, onClick }: Props) {
  const isRed = suit === "♥" || suit === "♦";

  return (
    <button
      onClick={onClick}
      style={{
        width: 70,
        height: 100,
        borderRadius: 10,
        border: selected ? "3px solid #0a7" : "1px solid #ccc",
        background: "white",
        color: isRed ? "#d22" : "#111",
        fontSize: 24,
        fontWeight: "bold",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 8,
        boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
        cursor: "pointer",
        transform: selected ? "translateY(-8px)" : "none",
        transition: "all 0.15s ease",
      }}
    >
      <span>{rank}</span>
      <span style={{ alignSelf: "center", fontSize: 28 }}>{suit}</span>
      <span style={{ alignSelf: "flex-end" }}>{rank}</span>
    </button>
  );
}