import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import LangToggle from "../components/LangToggle.jsx";
import { useArena } from "../useArena.js";
import { BOT_URL, explorerTx } from "../config.js";

// Offers are stored on-chain as "Name — argument". Split for display.
function parseOffer(o) {
  const raw = o.argument || "";
  const idx = raw.indexOf(" — ");
  if (idx > -1) {
    return { name: raw.slice(0, idx), text: raw.slice(idx + 3) };
  }
  const who = o.bidder ? `${o.bidder.slice(0, 6)}…${o.bidder.slice(-4)}` : "Anónimo";
  return { name: who, text: raw };
}

function useCountdown(deadline) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 250);
    return () => clearInterval(t);
  }, []);
  if (!deadline) return { secs: null, pct: 0 };
  const secs = Math.max(0, deadline - now);
  return { secs, now };
}

function Confetti() {
  const colors = ["#ffd166", "#2fe6a0", "#a78bff", "#ff5fa2", "#836ef9"];
  const bits = Array.from({ length: 80 }, (_, i) => i);
  return (
    <div className="confetti">
      {bits.map((i) => {
        const left = Math.random() * 100;
        const delay = Math.random() * 0.6;
        const dur = 2.2 + Math.random() * 2;
        const bg = colors[i % colors.length];
        return (
          <i
            key={i}
            style={{ left: `${left}vw`, background: bg, animationDelay: `${delay}s`, animationDuration: `${dur}s` }}
          />
        );
      })}
    </div>
  );
}

export default function Arena() {
  const { t } = useTranslation();
  const { prizeName, deadline, offers, phase, agent, reveal, PHASES } = useArena();
  const { secs } = useCountdown(deadline);

  // Typewriter for agent reasoning.
  const reasoning = agent?.reasoning || "";
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (phase !== PHASES.REASONING || !reasoning) {
      setTyped("");
      return;
    }
    let i = 0;
    const id = setInterval(() => {
      i += 2;
      setTyped(reasoning.slice(0, i));
      if (i >= reasoning.length) clearInterval(id);
    }, 28);
    return () => clearInterval(id);
  }, [phase, reasoning]);

  const winnerIndex = agent?.winnerIndex;
  const totalSecs = useMemo(() => 90, []);
  const pct = secs != null ? Math.min(100, (secs / totalSecs) * 100) : 0;

  const winnerOffer = offers[winnerIndex];
  const winnerParsed = winnerOffer ? parseOffer(winnerOffer) : null;
  const agentWinnerName =
    winnerParsed?.name ||
    (agent?.winner ? `${agent.winner.slice(0, 6)}…${agent.winner.slice(-4)}` : "—");

  return (
    <div className="arena">
      <LangToggle />

      <div className="arena-top">
        <div>
          <div className="brand">
            <span className="ball">⚽</span> {t("brand")}
          </div>
          <div className="tagline">{t("tagline")}</div>
        </div>
        {phase === PHASES.LIVE && (
          <div className="live-pill">
            <span className="dot" /> {t("live")}
          </div>
        )}
      </div>

      <div className="arena-body">
        {/* Left column: QR + prize + timer */}
        <div className="qr-col">
          <div className="qr-card">
            <h3>{t("scanToPlay")}</h3>
            <p>{t("scanHint")}</p>
            <div className="qr-frame">
              <QRCodeSVG value={BOT_URL || window.location.origin} size={210} level="M" />
            </div>
          </div>

          <div className="prize-card">
            <div className="label">{t("prizeLabel")}</div>
            <div className="name">{prizeName || "—"}</div>
            <div className="prize-emoji">⚽</div>

            <div className="timer">
              <div className="row">
                <span className="lbl">{t("timeLeft")}</span>
                <span className={`val ${secs != null && secs <= 10 ? "urgent" : ""}`}>
                  {secs != null ? `${secs}s` : "--"}
                </span>
              </div>
              <div className="timer-bar">
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
          </div>
        </div>

        {/* Right column: offers */}
        <div className="offers-col">
          <div className="offers-head">
            <h2>{t("offersIn")}</h2>
            <div className="offers-count">{offers.length}</div>
          </div>
          {offers.length === 0 ? (
            <div className="empty-offers">{t("waitingOffers")}</div>
          ) : (
            <div className="offers-grid">
              {offers.map((o, i) => {
                const p = parseOffer(o);
                const isWin = phase === PHASES.WINNER || phase === PHASES.REVEAL ? i === winnerIndex : false;
                return (
                  <div key={o.txHash || i} className={`offer-card ${isWin ? "win" : ""}`}>
                    <div className="top">
                      <span className="who">{isWin ? "👑 " : ""}{p.name}</span>
                      <span className="amt">{Number(o.amountMon)} MON</span>
                    </div>
                    <div className="arg">{p.text}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── Overlays ───────────────────────────────────────── */}
      {phase === PHASES.EVALUATING && (
        <div className="overlay evaluating">
          <div>
            <div className="ring" />
            <h1>{t("phaseEvaluating")}</h1>
            <div className="sub">{t("phaseEvaluatingSub")}</div>
          </div>
        </div>
      )}

      {phase === PHASES.REASONING && (
        <div className="overlay">
          <div className="reasoning-panel">
            <div className="kicker">🤖 {t("agentReasoning")}</div>
            {agent?.noOffers ? (
              <div className="text">{t("noOffers")}</div>
            ) : (
              <div className="text typewriter">{typed}</div>
            )}
          </div>
        </div>
      )}

      {phase === PHASES.WINNER && (
        <div className="overlay winner">
          <Confetti />
          <div>
            <div className="crown">👑</div>
            <h1>
              <span className="brand" style={{ letterSpacing: 4 }}>
                {t("winnerIs")}
              </span>
            </h1>
            <div className="who">{agentWinnerName}</div>
            <div className="bid">
              {t("winningBid")}: {Number(agent?.amountMon || winnerOffer?.amountMon || 0)} MON
            </div>
            {agent?.executing && <div className="sub">{t("executingTx")}</div>}
            {agent?.txHash && (
              <div className="tx">
                <span className="badge-confirm">✓ 0.4s</span>
                <a href={explorerTx(agent.txHash)} target="_blank" rel="noreferrer">
                  {t("viewOnExplorer")} ↗
                </a>
              </div>
            )}
          </div>
        </div>
      )}

      {phase === PHASES.REVEAL && reveal && (
        <div className="overlay reveal">
          <Confetti />
          <div>
            <h1>🎭 {t("theReveal")}</h1>
            <div className="reveal-grid">
              <div className="reveal-num min">
                <div className="lbl">{t("minPrice")}</div>
                <div className="v">{Number(reveal.minPriceMon)} </div>
              </div>
              <div className="reveal-num bid">
                <div className="lbl">{t("winningBid")}</div>
                <div className="v">{Number(reveal.winningBidMon)}</div>
              </div>
              <div className="reveal-num spread">
                <div className="lbl">{t("spread")}</div>
                <div className="v">
                  {Number(reveal.spreadMon) >= 0 ? "+" : ""}
                  {Number(reveal.spreadMon)}
                </div>
              </div>
            </div>
            <div className="spread-note">
              {Number(reveal.spreadMon) >= 0 ? t("spreadOver") : t("spreadUnder")} · MON
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
