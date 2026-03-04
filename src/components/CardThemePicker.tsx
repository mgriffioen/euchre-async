import { useCardTheme, type CardTheme } from "./CardThemeContext";

const THEMES: { id: CardTheme; label: string; description: string }[] = [
  {
    id: "classic",
    label: "🂡 Classic",
    description: "Clean white cards",
  },
  {
    id: "eightbit",
    label: "👾 8-Bit",
    description: "CRT terminal style",
  },
  {
    id: "oldwest",
    label: "🤠 Old West",
    description: "Aged parchment",
  },
];

export default function CardThemePicker() {
  const { theme, setTheme } = useCardTheme();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#555", whiteSpace: "nowrap" }}>
        Card style:
      </span>
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          title={t.description}
          style={{
            padding: "5px 10px",
            borderRadius: 8,
            border: theme === t.id ? "2px solid #0a7" : "1px solid #ccc",
            background: theme === t.id ? "#d1e7dd" : "#fafafa",
            fontWeight: theme === t.id ? 700 : 400,
            fontSize: 13,
            cursor: "pointer",
            whiteSpace: "nowrap",
            transition: "all 0.12s ease",
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}