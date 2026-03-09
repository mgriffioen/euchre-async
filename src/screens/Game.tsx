import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { collection, doc, onSnapshot } from "firebase/firestore";

import { db } from "../firebase";
import { ensureAnonAuth } from "../auth";

import Card from "../components/Card";
import SeatCard from "../components/SeatCard";
import TrumpIndicator from "../components/TrumpIndicator";
import TurnBanner from "../components/TurnBanner";
import BiddingRound1Panel from "../components/BiddingRound1Panel";
import BiddingRound2Panel from "../components/BiddingRound2Panel";
import DealerDiscardPanel from "../components/DealerDiscardPanel";
import TrickCompletePanel from "../components/TrickCompletePanel";
import PlayerHand from "../components/PlayerHand";
import CardThemePicker from "../components/CardThemePicker";

import { parseCard, rankLabel, suitSymbol } from "../lib/cards";
import type { CardCode } from "../lib/cards";
import { effectiveSuit, hasSuitInHand, realToDisplaySeat, teamKeyForSeat } from "../lib/gameLogic";
import type { GameDoc, PlayerDoc, Seat, Suit, TeamKey } from "../types/game";
import { SEATS, SUITS } from "../types/game";
import { useGameActions } from "../hooks/useGameActions";

import "./game.css";

export default function Game() {
  const { gameId } = useParams();

  // ---------------------------------------------------------------------------
  // Local UI state
  // ---------------------------------------------------------------------------

  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [goAloneIntent, setGoAloneIntent] = useState(false);
  const [selectedCard, setSelectedCard] = useState<number | null>(null);

  const [savedName, setSavedName] = useState<string>(() => (localStorage.getItem("playerName") || "").trim());
  const [nameDraft, setNameDraft] = useState<string>(() => (localStorage.getItem("playerName") || "").trim());
  const hasName = savedName.trim().length > 0;

  function saveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    localStorage.setItem("playerName", trimmed);
    setSavedName(trimmed);
    setNameDraft(trimmed);
    setErr(null);
  }

  // ---------------------------------------------------------------------------
  // Firestore state
  // ---------------------------------------------------------------------------

  const [uid, setUid] = useState<string | null>(null);
  const [game, setGame] = useState<GameDoc | null>(null);
  const [players, setPlayers] = useState<Record<string, PlayerDoc>>({});
  const [myHand, setMyHand] = useState<CardCode[]>([]);

  const gameRef = useMemo(() => (gameId ? doc(db, "games", gameId) : null), [gameId]);

  // ---------------------------------------------------------------------------
  // Derived values
  // ---------------------------------------------------------------------------

  const mySeat: Seat | null =
    uid && game
      ? ((Object.entries(game.seats).find(([, v]) => v === uid)?.[0] as Seat | undefined) ?? null)
      : null;

  const isGameFinished = game?.status === "finished";

  const canDeal =
    !!game && !isGameFinished && game.status === "lobby" && (game.phase === "lobby" || !game.phase) &&
    hasName && !!mySeat && mySeat === (game.dealer ?? "N");

  const isMyTurn = !!uid && !!game && !!mySeat && game.turn === mySeat;

  const scoreNS = game?.score?.NS ?? 0;
  const scoreEW = game?.score?.EW ?? 0;
  const winnerTeam = game?.winnerTeam ?? null;
  const winnerLabel = winnerTeam === "NS" ? "Team A" : winnerTeam === "EW" ? "Team B" : null;

  const teamUi = useMemo(() => {
    const aTeam: TeamKey = "NS";
    const bTeam: TeamKey = "EW";
    const labelForTeam: Record<TeamKey, string> = { NS: "Team A", EW: "Team B" };
    return { aTeam, bTeam, labelForTeam };
  }, []);

  const url = typeof window !== "undefined" ? window.location.href : "";
  const upcardSuit: Suit | null = game?.upcard ? (game.upcard[1] as Suit) : null;
  const round2AllowedSuits: Suit[] = upcardSuit ? SUITS.filter((s) => s !== upcardSuit) : SUITS;
  const isDealerStuck =
    !!game && game.phase === "bidding_round_2" && game.bidding?.round === 2 &&
    (game.bidding?.passes?.length ?? 0) === 3 && game.turn === game.dealer;

  const goingAlone = game?.goingAlone ?? false;
  const partnerSeatReal: Seat | null = (game?.partnerSeat as Seat | null) ?? null;

  // During dealer_discard the dealer sees 6 cards (hand + upcard).
  const displayHand: CardCode[] = useMemo(() => {
    if (game?.phase === "dealer_discard" && mySeat === game.dealer && game.upcard) {
      return [...myHand, game.upcard];
    }
    return myHand;
  }, [game?.phase, game?.dealer, game?.upcard, mySeat, myHand]);

  // Seat rotation helpers — Firestore uses real seats; UI rotates to show local player at South.
  const displaySeat = (real: Seat): Seat => (mySeat ? realToDisplaySeat(real, mySeat) : real);

  const displayDealer: Seat | null = game?.dealer ? displaySeat(game.dealer) : null;
  const displayTurn: Seat | null = game?.turn ? displaySeat(game.turn) : null;
  const displayPasses: Seat[] = (game?.bidding?.passes ?? []).map((s) => displaySeat(s as Seat));

  // Maps each display position back to the real seat.
  const displaySeats: Record<Seat, Seat> = useMemo(() => {
    if (!mySeat) return { N: "N", E: "E", S: "S", W: "W" };
    const m: Record<Seat, Seat> = { N: "N", E: "E", S: "S", W: "W" };
    (SEATS as Seat[]).forEach((real) => { m[realToDisplaySeat(real, mySeat)] = real; });
    return m;
  }, [mySeat]);

  const turnName =
    game?.turn && game.seats[game.turn]
      ? players[game.seats[game.turn] as string]?.name || (displayTurn ?? game.turn)
      : displayTurn ?? game?.turn;

  const seatLabel = (realSeat: Seat) => {
    if (!game) return "Open";
    const seatUid = game.seats[realSeat];
    return seatUid ? players[seatUid]?.name || "Taken" : "Open";
  };

  // Which cards in the hand are legally playable.
  const playableInfo = useMemo(() => {
    if (!game || game.phase !== "playing" || !isMyTurn || !mySeat || !game.trump) {
      return { mustFollow: null as Suit | null, playableSet: null as Set<CardCode> | null };
    }
    const trump = game.trump;
    const cards = game.currentTrick?.cards ?? {};
    const leadSuit = Object.keys(cards).length > 0 ? (game.currentTrick?.leadSuit ?? null) : null;
    if (!leadSuit) return { mustFollow: null, playableSet: null };

    const mustFollow = hasSuitInHand(myHand, leadSuit, trump) ? leadSuit : null;
    if (!mustFollow) return { mustFollow: null, playableSet: null };

    const playable = new Set<CardCode>();
    myHand.forEach((c) => { if (effectiveSuit(c, trump) === mustFollow) playable.add(c); });
    return { mustFollow, playableSet: playable };
  }, [game, isMyTurn, mySeat, myHand]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const actions = useGameActions({
    gameRef, gameId, game, uid, mySeat, hasName, savedName, players, isGameFinished,
    setErr, setSelectedCard, setGoAloneIntent, setCopied,
  });

  // ---------------------------------------------------------------------------
  // Effects
  // ---------------------------------------------------------------------------

  useEffect(() => {
    ensureAnonAuth().then((u) => setUid(u.uid)).catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!gameRef) return;
    const unsub = onSnapshot(
      gameRef,
      (snap) => {
        if (!snap.exists()) { setGame(null); setErr("Game not found (check the id)."); return; }
        setErr(null);
        setGame(snap.data() as GameDoc);
      },
      (e) => setErr(String(e))
    );
    return () => unsub();
  }, [gameRef]);

  useEffect(() => {
    if (!gameId) return;
    const unsub = onSnapshot(
      collection(db, "games", gameId, "players"),
      (snap) => {
        const p: Record<string, PlayerDoc> = {};
        snap.forEach((d) => { p[d.id] = d.data() as PlayerDoc; });
        setPlayers(p);
      },
      (e) => setErr(String(e))
    );
    return () => unsub();
  }, [gameId]);

  useEffect(() => {
    if (!gameId || !uid) return;
    const unsub = onSnapshot(
      doc(db, "games", gameId, "players", uid),
      (snap) => {
        if (!snap.exists()) { setMyHand([]); return; }
        setMyHand(((snap.data() as PlayerDoc).hand ?? []) as CardCode[]);
      },
      (e) => setErr(String(e))
    );
    return () => unsub();
  }, [gameId, uid]);

  // ---------------------------------------------------------------------------
  // Render helper — seat box
  // ---------------------------------------------------------------------------

  const renderSeat = (displayPos: Seat, gridColumn: string, gridRow: string) => {
    if (!game) return null;
    const realSeat = displaySeats[displayPos];
    const teamKey = teamKeyForSeat(realSeat);
    const tricksWon = (game.phase === "playing" || game.phase === "trick_complete")
      ? (game.tricksTaken?.[teamKey] ?? 0)
      : undefined;
    return (
      <div style={{ gridColumn, gridRow, minHeight: 0, overflow: "hidden" }}>
        <SeatCard
          seat={displayPos}
          label={seatLabel(realSeat)}
          isYou={mySeat === realSeat}
          isTurn={game.turn === realSeat}
          teamLabel={teamUi.labelForTeam[teamKeyForSeat(realSeat)]}
          isDealer={game.dealer === realSeat}
          isSittingOut={goingAlone && realSeat === partnerSeatReal}
          canClaim={!!uid && !game.seats[realSeat] && !mySeat}
          playedCard={
            // S = local player; card shown above the hand strip instead
            displayPos !== "S" && (game.phase === "playing" || game.phase === "trick_complete")
              ? (game.currentTrick?.cards?.[realSeat] ?? null)
              : null
          }
          tricksWon={tricksWon}
          onClaim={() => actions.claimSeat(realSeat)}
        />
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="g-game">
      {/* Name gate — full-screen overlay until name is entered */}
      {!hasName && (
        <div className="g-name-overlay">
          <div className="g-card">
            <h4 style={{ marginTop: 0 }}>Enter your name</h4>
            <div style={{ color: "#555", marginBottom: 10 }}>
              You'll need a name before you can join or take actions in this game.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Your name"
                style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 16 }}
                autoFocus
                onKeyDown={(e) => { if (e.key === "Enter") saveName(); }}
              />
              <button className="g-btn" onClick={saveName} disabled={!nameDraft.trim()}>Continue</button>
            </div>
          </div>
        </div>
      )}

      {/* Top bar — game info, status, score */}
      <div className="g-top-bar">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Link to="/" state={{ joinCode: gameId }} className="g-copy-btn" style={{ fontSize: 14, padding: "3px 8px", textDecoration: "none" }} title="Home">🏠</Link>
          <span style={{ fontSize: 13, opacity: 0.55 }}>Game: <b>{gameId}</b></span>
          <button type="button" onClick={() => actions.copyShareLink(url)} className="g-copy-btn" style={{ fontSize: 12, padding: "3px 8px" }}>
            {copied ? "✓ Copied" : "Share"}
          </button>
          <div style={{ marginLeft: "auto" }}>
            <CardThemePicker />
          </div>
        </div>

        {!game ? <p>Loading…</p> : (
          <>
            <TurnBanner
              phase={game.phase}
              isMyTurn={isMyTurn}
              turnName={turnName}
              mySeat={mySeat}
              dealer={game.dealer}
              displayDealer={displayDealer}
              goingAlone={goingAlone}
              partnerSeatReal={partnerSeatReal}
              biddingPassesLength={game.bidding?.passes?.length ?? 0}
            />

            {err && <div className="g-alert">{err}</div>}

            {game.status === "finished" && winnerLabel && (
              <div className="g-winner">
                <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 0.2 }}>🏆 {winnerLabel} wins!</div>
              </div>
            )}

            <div className="g-score-row">
              <span className="g-score-pill">
                <span className="g-score-label">Team A</span>
                <span style={{ minWidth: 18, textAlign: "center" }}>{scoreNS}</span>
                <span className="g-score-sep">–</span>
                <span style={{ minWidth: 18, textAlign: "center" }}>{scoreEW}</span>
                <span className="g-score-label">Team B</span>
              </span>
              {(game.phase === "playing" || game.phase === "dealer_discard" || game.phase === "trick_complete") && game.trump && (
                <div style={{ marginLeft: "auto" }}>
                  <TrumpIndicator suit={suitSymbol(game.trump)} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Table area — fills remaining viewport height */}
      {game && (
        <div className="g-table-area">
          <div className="g-table">
            {renderSeat("N", "2 / 3", "1 / 2")}
            {renderSeat("W", "1 / 2", "2 / 3")}
            {/* Upcard in table center during bidding */}
            {game.upcard && game.phase !== "playing" && game.phase !== "trick_complete" && (() => {
              const { rank, suit } = parseCard(game.upcard as CardCode);
              return (
                <div style={{ gridColumn: "2/3", gridRow: "2/3", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ marginBottom: 4, fontSize: 11, opacity: 0.55 }}>Upcard</div>
                    <Card rank={rankLabel(rank)} suit={suitSymbol(suit)} selected={false} onClick={() => {}} />
                  </div>
                </div>
              );
            })()}
            {renderSeat("E", "3 / 4", "2 / 3")}
            {renderSeat("S", "2 / 3", "3 / 4")}
          </div>

          {/* Bidding / discard — backdrop + bottom panel */}
          {(game.phase === "bidding_round_1" ||
            game.phase === "bidding_round_2" ||
            game.phase === "dealer_discard") && (
            <>
              <div className="g-phase-backdrop" />
              <div className="g-phase-overlay">
                {game.phase === "bidding_round_1" && (
                  <BiddingRound1Panel
                    displayTurn={displayTurn} gameTurn={game.turn} displayPasses={displayPasses}
                    mySeat={mySeat} onOrderUp={actions.bidOrderUp} onPass={actions.bidPassRound1}
                  />
                )}
                {game.phase === "bidding_round_2" && (
                  <BiddingRound2Panel
                    displayTurn={displayTurn} gameTurn={game.turn} displayPasses={displayPasses}
                    isDealerStuck={isDealerStuck} displayDealer={displayDealer} gameDealer={game.dealer}
                    mySeat={mySeat} upcardSuit={upcardSuit} round2AllowedSuits={round2AllowedSuits}
                    goAloneIntent={goAloneIntent} onGoAloneChange={setGoAloneIntent}
                    onCallTrump={actions.bidCallTrump} onPass={actions.bidPassRound2}
                  />
                )}
                {game.phase === "dealer_discard" && (
                  <DealerDiscardPanel
                    trump={game.trump} mySeat={mySeat} gameDealer={game.dealer}
                    displayDealer={displayDealer} selectedCard={selectedCard}
                    displayHand={displayHand} setErr={setErr} onDiscard={actions.dealerPickupAndDiscard}
                  />
                )}
              </div>
            </>
          )}

          {/* Trick complete — slides in from top, no backdrop so all played cards stay visible */}
          {game.phase === "trick_complete" && game.currentTrick?.trickWinner && (() => {
            const trickWinnerSeat = game.currentTrick.trickWinner as Seat;
            const trickWinnerUid = game.seats[trickWinnerSeat];
            const trickWinnerName = trickWinnerUid
              ? players[trickWinnerUid]?.name || displaySeat(trickWinnerSeat)
              : displaySeat(trickWinnerSeat);
            return (
              <div className="g-trick-complete-overlay">
                <TrickCompletePanel
                  trickWinnerName={trickWinnerName}
                  isLastTrick={(game.currentTrick?.trickNumber ?? 0) >= 5}
                  iWonTheTrick={mySeat === trickWinnerSeat}
                  onAdvance={actions.advanceTrick}
                />
              </div>
            );
          })()}
        </div>
      )}

      {/* Player hand — always visible at bottom */}
      {game && (
        <div className="g-hand-sticky">
          {/* Own played card — shown here instead of the cramped S seat cell */}
          {mySeat && (game.phase === "playing" || game.phase === "trick_complete") &&
            game.currentTrick?.cards?.[mySeat] && (() => {
              const { rank, suit } = parseCard(game.currentTrick.cards[mySeat] as CardCode);
              const CW = Math.round(70 * 0.55);
              const CH = Math.round(100 * 0.55);
              return (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 10px 4px" }}>
                  <span style={{ fontSize: 11, opacity: 0.55, flexShrink: 0 }}>You played:</span>
                  <div style={{ width: CW, height: CH, overflow: "hidden", flexShrink: 0 }}>
                    <div style={{ transform: "scale(0.55)", transformOrigin: "top left" }}>
                      <Card rank={rankLabel(rank)} suit={suitSymbol(suit)} selected={false} onClick={() => {}} />
                    </div>
                  </div>
                </div>
              );
            })()}
          {canDeal && (
            <button onClick={actions.startHand} className="g-btn" style={{ width: "100%", marginBottom: 8 }}>
              Deal
            </button>
          )}
          <PlayerHand
            displayHand={displayHand}
            phase={game.phase}
            isMyTurn={isMyTurn}
            mustFollow={playableInfo.mustFollow}
            playableSet={playableInfo.playableSet}
            selectedCard={selectedCard}
            onSelect={setSelectedCard}
            onPlay={actions.playCard}
          />
        </div>
      )}
    </div>
  );
}
