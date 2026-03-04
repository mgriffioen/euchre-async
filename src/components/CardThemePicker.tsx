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
      <style>{`
        .theme-btn {
          padding: 5px 10px;
          border-radius: 8px;
          font-size: 13px;
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.12s ease;
          border: 1px solid #ccc;
          background: transparent;
          color: inherit;
          font-weight: 400;
        }
        .theme-btn.active {
          border: 2px solid #0a7;
          background: #0a7;
          color: #fff;
          font-weight: 700;
        }
        @media (prefers-color-scheme: dark) {
          .theme-btn {
            border-color: #555;
          }
          .theme-btn.active {
            border-color: #0a7;
            background: #0a7;
            color: #fff;
          }
        }
      `}</style>
      <span style={{ fontSize: 13, fontWeight: 600, color: "inherit", opacity: 0.6, whiteSpace: "nowrap" }}>
        Card style:
      </span>
      {THEMES.map((t) => (
        <button
          key={t.id}
          onClick={() => setTheme(t.id)}
          title={t.description}
          className={`theme-btn${theme === t.id ? " active" : ""}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}