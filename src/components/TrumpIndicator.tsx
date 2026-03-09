import { useCardTheme } from "./CardThemeContext";

export default function TrumpIndicator({ suit }: { suit: string }) {
  const { theme } = useCardTheme();
  const isRed = suit === "\u2665" || suit === "\u2666";

  const suitColor =
    theme === "eightbit"
      ? isRed ? "#ff2a6d" : "#00ff41"
      : theme === "oldwest"
      ? isRed ? "#8b1a1a" : "#1a0a00"
      : theme === "royal"
      ? isRed ? "#c0392b" : "#c9a227"
      : theme === "tropical"
      ? isRed ? "#e11d48" : "#0e7490"
      : isRed ? "#d22" : "#111";

  return (
    <div className={`g-trump theme-${theme}`}>
      <div className="g-trump-label">Trump</div>
      <span className="g-trump-suit" style={{ color: suitColor }}>
        {suit}
      </span>
    </div>
  );
}
