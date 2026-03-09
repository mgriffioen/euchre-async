import { useCardTheme, type CardTheme } from "./CardThemeContext";

type Props = {
  rank: string;
  suit: "♠" | "♥" | "♦" | "♣";
  selected?: boolean;
  onClick?: () => void;
};

// =============================================================================
// Theme Definitions
// =============================================================================

type ThemeStyles = {
  card: React.CSSProperties;
  cardSelected: React.CSSProperties;
  redColor: string;
  blackColor: string;
  suitStyle?: React.CSSProperties;
  rankStyle?: React.CSSProperties;
  overlay?: React.ReactNode;
};

function getThemeStyles(theme: CardTheme, isRed: boolean, selected: boolean): ThemeStyles {
  if (theme === "eightbit") {
    return {
      card: {
        width: 70,
        height: 100,
        borderRadius: 0,
        border: "3px solid #00ff41",
        background: "#0d0d0d",
        boxShadow: selected
          ? "0 0 0 2px #0d0d0d, 0 0 0 4px #00ff41, 0 0 16px #00ff41"
          : "3px 3px 0 #00ff41",
        cursor: "pointer",
        transform: selected ? "translateY(-8px)" : "none",
        transition: "all 0.1s steps(2)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 6,
        fontFamily: '"Courier New", Courier, monospace',
        imageRendering: "pixelated",
        position: "relative",
        overflow: "hidden",
      },
      cardSelected: {},
      redColor: "#ff2a6d",
      blackColor: "#00ff41",
      rankStyle: {
        fontSize: 18,
        fontWeight: 900,
        letterSpacing: -1,
        lineHeight: 1,
        textShadow: isRed ? "0 0 6px #ff2a6d" : "0 0 6px #00ff41",
      },
      suitStyle: {
        alignSelf: "center",
        fontSize: 26,
        textShadow: isRed ? "0 0 8px #ff2a6d" : "0 0 8px #00ff41",
      },
      overlay: (
        <>
          {/* CRT scanlines */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              backgroundImage:
                "repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.35) 3px, rgba(0,0,0,0.35) 4px)",
              zIndex: 1,
            }}
          />
          {/* Corner pixel dots */}
          <div style={{ position: "absolute", top: 2, right: 2, width: 4, height: 4, background: "#00ff41", opacity: 0.5, zIndex: 2 }} />
          <div style={{ position: "absolute", bottom: 2, left: 2, width: 4, height: 4, background: "#00ff41", opacity: 0.5, zIndex: 2 }} />
        </>
      ),
    };
  }

  if (theme === "oldwest") {
    return {
      card: {
        width: 70,
        height: 100,
        borderRadius: 4,
        border: selected ? "2px solid #5c2e00" : "2px solid #8b5c2a",
        background: "linear-gradient(145deg, #f5e6c8 0%, #ede0b0 40%, #e8d49a 100%)",
        boxShadow: selected
          ? "0 6px 18px rgba(92,46,0,0.55), inset 0 0 12px rgba(139,92,42,0.25)"
          : "2px 3px 8px rgba(92,46,0,0.35), inset 0 0 8px rgba(139,92,42,0.15)",
        cursor: "pointer",
        transform: selected ? "translateY(-8px) rotate(0.5deg)" : "none",
        transition: "all 0.15s ease",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 7,
        fontFamily: '"Palatino Linotype", Palatino, "Book Antiqua", serif',
        position: "relative",
        overflow: "hidden",
      },
      cardSelected: {},
      redColor: "#8b1a1a",
      blackColor: "#1a0a00",
      rankStyle: {
        fontSize: 20,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: 0.5,
      },
      suitStyle: {
        alignSelf: "center",
        fontSize: 26,
      },
      overlay: (
        <>
          {/* Aged paper texture vignette */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              background:
                "radial-gradient(ellipse at center, transparent 55%, rgba(92,46,0,0.18) 100%)",
              zIndex: 1,
            }}
          />
          {/* Worn edge top */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: 3,
              background:
                "repeating-linear-gradient(90deg, transparent, transparent 3px, rgba(92,46,0,0.12) 3px, rgba(92,46,0,0.12) 5px)",
              zIndex: 2,
            }}
          />
          {/* Corner flourish dots */}
          <div style={{ position: "absolute", top: 3, left: 3, width: 3, height: 3, borderRadius: "50%", background: "rgba(92,46,0,0.3)", zIndex: 2 }} />
          <div style={{ position: "absolute", top: 3, right: 3, width: 3, height: 3, borderRadius: "50%", background: "rgba(92,46,0,0.3)", zIndex: 2 }} />
          <div style={{ position: "absolute", bottom: 3, left: 3, width: 3, height: 3, borderRadius: "50%", background: "rgba(92,46,0,0.3)", zIndex: 2 }} />
          <div style={{ position: "absolute", bottom: 3, right: 3, width: 3, height: 3, borderRadius: "50%", background: "rgba(92,46,0,0.3)", zIndex: 2 }} />
        </>
      ),
    };
  }

  if (theme === "royal") {
    return {
      card: {
        width: 70,
        height: 100,
        borderRadius: 6,
        border: selected ? "2px solid #c9a227" : "2px solid #6b521a",
        background: "linear-gradient(160deg, #3b2a7a 0%, #2d1f66 50%, #3b2a7a 100%)",
        boxShadow: selected
          ? "0 8px 24px rgba(201,162,39,0.45), inset 0 0 20px rgba(201,162,39,0.12), 0 0 0 1px #c9a227"
          : "0 4px 12px rgba(0,0,0,0.4), inset 0 0 12px rgba(201,162,39,0.08)",
        cursor: "pointer",
        transform: selected ? "translateY(-10px)" : "none",
        transition: "all 0.2s ease",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 7,
        fontFamily: '"Georgia", "Times New Roman", serif',
        position: "relative",
        overflow: "hidden",
      },
      cardSelected: {},
      redColor: "#c0392b",
      blackColor: "#c9a227",
      rankStyle: {
        fontSize: 20,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: 0.5,
      },
      suitStyle: {
        alignSelf: "center",
        fontSize: 26,
      },
      overlay: (
        <>
          {/* Gold shimmer top edge */}
          <div
            style={{
              position: "absolute",
              top: 0, left: 0, right: 0,
              height: 1,
              background: "linear-gradient(90deg, transparent, #c9a227, transparent)",
              zIndex: 1,
            }}
          />
          {/* Gold shimmer bottom edge */}
          <div
            style={{
              position: "absolute",
              bottom: 0, left: 0, right: 0,
              height: 1,
              background: "linear-gradient(90deg, transparent, #c9a227, transparent)",
              zIndex: 1,
            }}
          />
          {/* Corner ornaments */}
          <div style={{ position: "absolute", top: 3, left: 3, width: 5, height: 5, border: "1px solid #c9a227", opacity: 0.6, zIndex: 2 }} />
          <div style={{ position: "absolute", top: 3, right: 3, width: 5, height: 5, border: "1px solid #c9a227", opacity: 0.6, zIndex: 2 }} />
          <div style={{ position: "absolute", bottom: 3, left: 3, width: 5, height: 5, border: "1px solid #c9a227", opacity: 0.6, zIndex: 2 }} />
          <div style={{ position: "absolute", bottom: 3, right: 3, width: 5, height: 5, border: "1px solid #c9a227", opacity: 0.6, zIndex: 2 }} />
        </>
      ),
    };
  }

  if (theme === "tropical") {
    return {
      card: {
        width: 70,
        height: 100,
        borderRadius: 8,
        border: selected ? "2px solid #0891b2" : "2px solid #67e8f9",
        background: "linear-gradient(170deg, #e0f7ff 0%, #bae6fd 45%, #fef9c3 100%)",
        boxShadow: selected
          ? "0 8px 20px rgba(8,145,178,0.4), 0 0 0 1px #0891b2"
          : "0 3px 10px rgba(8,145,178,0.2)",
        cursor: "pointer",
        transform: selected ? "translateY(-10px)" : "none",
        transition: "all 0.18s ease",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 7,
        fontFamily: "system-ui, -apple-system, sans-serif",
        position: "relative",
        overflow: "hidden",
      },
      cardSelected: {},
      redColor: "#e11d48",
      blackColor: "#0e7490",
      rankStyle: {
        fontSize: 20,
        fontWeight: 700,
        lineHeight: 1,
      },
      suitStyle: {
        alignSelf: "center",
        fontSize: 26,
      },
      overlay: (
        <>
          {/* Sun glow top-right */}
          <div
            style={{
              position: "absolute",
              top: -12, right: -12,
              width: 32, height: 32,
              borderRadius: "50%",
              background: "radial-gradient(circle, rgba(251,191,36,0.55) 0%, transparent 70%)",
              zIndex: 1,
            }}
          />
          {/* Wave strip at bottom */}
          <div
            style={{
              position: "absolute",
              bottom: 0, left: 0, right: 0,
              height: 10,
              background: "repeating-linear-gradient(90deg, #67e8f9 0px, #22d3ee 8px, #67e8f9 16px)",
              opacity: 0.35,
              zIndex: 1,
            }}
          />
        </>
      ),
    };
  }

  // Classic (default)
  return {
    card: {
      width: 70,
      height: 100,
      borderRadius: 10,
      border: selected ? "3px solid #0a7" : "1px solid #ccc",
      background: "white",
      boxShadow: "0 2px 6px rgba(0,0,0,0.15)",
      cursor: "pointer",
      transform: selected ? "translateY(-8px)" : "none",
      transition: "all 0.15s ease",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: 8,
    },
    cardSelected: {},
    redColor: "#d22",
    blackColor: "#111",
    rankStyle: {
      fontSize: 24,
      fontWeight: "bold",
      lineHeight: 1,
    },
    suitStyle: {
      alignSelf: "center",
      fontSize: 28,
    },
  };
}

// =============================================================================
// Card Component
// =============================================================================

export default function Card({ rank, suit, selected = false, onClick }: Props) {
  const { theme } = useCardTheme();
  const isRed = suit === "♥" || suit === "♦";
  const ts = getThemeStyles(theme, isRed, selected);
  const color = isRed ? ts.redColor : ts.blackColor;

  return (
    <button
      onClick={onClick}
      style={{
        ...ts.card,
        color,
        // Reset browser button defaults
        fontFamily: ts.card.fontFamily ?? "inherit",
      }}
    >
      {ts.overlay}

      <span style={{ position: "relative", zIndex: 3, ...ts.rankStyle }}>
        {rank}
      </span>

      <span style={{ position: "relative", zIndex: 3, ...ts.suitStyle }}>
        {suit}
      </span>

      <span
        style={{
          position: "relative",
          zIndex: 3,
          alignSelf: "flex-end",
          ...ts.rankStyle,
        }}
      >
        {rank}
      </span>
    </button>
  );
}