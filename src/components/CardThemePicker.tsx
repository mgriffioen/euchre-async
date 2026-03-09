import { useState } from "react";
import { useCardTheme, type CardTheme } from "./CardThemeContext";

const THEMES: { id: CardTheme; label: string; description: string }[] = [
  { id: "classic",  label: "🂡 Classic",  description: "Clean white cards" },
  { id: "eightbit", label: "👾 8-Bit",    description: "CRT terminal style" },
  { id: "oldwest",  label: "🤠 Old West", description: "Aged parchment" },
  { id: "royal",    label: "👑 Royal",    description: "Luxury gold on midnight" },
  { id: "tropical", label: "🌴 Tropical", description: "Beach vibes" },
];

export default function CardThemePicker() {
  const { theme, setTheme } = useCardTheme();
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <style>{`
        .theme-btn {
          display: block;
          width: 100%;
          padding: 7px 10px;
          border-radius: 8px;
          font-size: 13px;
          cursor: pointer;
          white-space: nowrap;
          text-align: left;
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
        .theme-picker-dropdown {
          position: absolute;
          top: calc(100% + 4px);
          right: 0;
          z-index: 51;
          background: var(--bg, #fff);
          border: 1px solid #ddd;
          border-radius: 10px;
          padding: 6px;
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 160px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.18);
        }
        @media (prefers-color-scheme: dark) {
          .theme-btn { border-color: #555; }
          .theme-btn.active { border-color: #0a7; background: #0a7; color: #fff; }
          .theme-picker-dropdown { border-color: #444; box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
        }
      `}</style>

      <button
        onClick={() => setOpen((o) => !o)}
        className="g-copy-btn"
        style={{ fontSize: 12, padding: "3px 8px" }}
        title="Card style"
      >
        🎨 Style
      </button>

      {open && (
        <>
          {/* invisible backdrop closes the menu */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 50 }}
            onClick={() => setOpen(false)}
          />
          <div className="theme-picker-dropdown">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTheme(t.id); setOpen(false); }}
                title={t.description}
                className={`theme-btn${theme === t.id ? " active" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
