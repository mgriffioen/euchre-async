import { createContext, useContext, useState } from "react";

export type CardTheme = "classic" | "eightbit" | "oldwest" | "royal" | "tropical";

type CardThemeContextValue = {
  theme: CardTheme;
  setTheme: (t: CardTheme) => void;
};

const CardThemeContext = createContext<CardThemeContextValue>({
  theme: "classic",
  setTheme: () => {},
});

const STORAGE_KEY = "euchre-card-theme";

export function CardThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<CardTheme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return (stored as CardTheme) ?? "classic";
  });

  function setTheme(t: CardTheme) {
    setThemeState(t);
    localStorage.setItem(STORAGE_KEY, t);
  }

  return (
    <CardThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </CardThemeContext.Provider>
  );
}

export function useCardTheme() {
  return useContext(CardThemeContext);
}