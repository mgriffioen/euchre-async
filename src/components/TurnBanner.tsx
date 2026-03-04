import type { GamePhase, Seat } from "../types/game";

interface Props {
  phase: GamePhase | undefined;
  isMyTurn: boolean;
  turnName: string | Seat | null | undefined;
  mySeat: Seat | null;
  dealer: Seat;
  displayDealer: Seat | null;
  goingAlone: boolean;
  partnerSeatReal: Seat | null;
  biddingPassesLength: number;
}

export default function TurnBanner({
  phase, isMyTurn, turnName, mySeat, dealer, displayDealer,
  goingAlone, partnerSeatReal, biddingPassesLength,
}: Props) {
  const content = phase?.startsWith("bidding") ? (
    isMyTurn ? (
      <>
        🟢{" "}
        {phase === "bidding_round_2" && biddingPassesLength === 3 && mySeat === dealer
          ? "Dealer must choose trump"
          : "Your turn to bid"}
      </>
    ) : (
      <>⏳ Waiting for {turnName} to bid…</>
    )
  ) : phase === "dealer_discard" ? (
    goingAlone && mySeat === partnerSeatReal ? (
      <>🪑 Your partner is going alone — you're sitting out this hand</>
    ) : mySeat === dealer ? (
      <>🟢 Dealer: pick up the upcard and discard</>
    ) : (
      <>⏳ Waiting for dealer ({displayDealer ?? dealer}) to discard…</>
    )
  ) : phase === "trick_complete" ? (
    isMyTurn ? (
      <>🟢 You won the trick — continue when ready</>
    ) : (
      <>⏳ Waiting for {turnName} to continue…</>
    )
  ) : phase === "playing" ? (
    goingAlone && mySeat === partnerSeatReal ? (
      <>🪑 Your partner is going alone — you're sitting out this hand</>
    ) : isMyTurn ? (
      <>🟢 Your turn</>
    ) : (
      <>⏳ Waiting for {turnName}…</>
    )
  ) : (
    <>Waiting…</>
  );

  return <div className={`g-banner${isMyTurn ? " my-turn" : ""}`}>{content}</div>;
}
