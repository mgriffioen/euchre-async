export type SuitChar = "S" | "H" | "D" | "C";
export type RankChar = "9" | "T" | "J" | "Q" | "K" | "A";

export type CardCode = `${RankChar}${SuitChar}`;

export function suitSymbol(s: SuitChar): "♠" | "♥" | "♦" | "♣" {
  switch (s) {
    case "S":
      return "♠";
    case "H":
      return "♥";
    case "D":
      return "♦";
    case "C":
      return "♣";
  }
}

export function rankLabel(r: RankChar): string {
  return r === "T" ? "10" : r;
}

export function parseCard(code: string) {
  // minimal safety
  const rank = code[0] as RankChar;
  const suit = code[1] as SuitChar;
  return { rank, suit };
}