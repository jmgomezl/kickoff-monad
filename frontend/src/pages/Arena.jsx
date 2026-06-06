import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import LangToggle from "../components/LangToggle.jsx";
import { useArena } from "../useArena.js";
import { BOT_URL, explorerTx } from "../config.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const num = (v) => Number(v || 0).toLocaleString();

function useCountdown(deadline) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 250);
    return () => clearInterval(t);
  }, []);
  if (!deadline) return { secs: null };
  return { secs: Math.max(0, deadline - now) };
}

function Confetti() {
  const colors = ["#ffd166", "#2fe6a0", "#a78bff", "#ff5fa2", "#836ef9"];
  return (
    <div className="confetti">
      {Array.from({ length: 80 }, (_, i) => (
        <i
          key={i}
          style={{
            left: `${Math.random() * 100}vw`,
            background: colors[i % colors.length],
            animationDelay: `${Math.random() * 0.6}s`,
            animationDuration: `${2.2 + Math.random() * 2}s`,
          }}
        />
      ))}
    </div>
  );
}

export default function Arena() {
  const { t } = useTranslation();
  const { itemName, deadline, offers, phase, agent, reveal, PHASES } = useArena();
  const { secs } = useCountdown(deadline);

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
    }, 26);
    return () => clearInterval(id);
  }, [phase, reasoning]);

  const winnerIndex = agent?.winnerIndex;
  const totalSecs = useMemo(() => 90, []);
  const pct = secs != null ? Math.min(100, (secs / totalSecs) * 100) : 0;
  const winnerName = agent?.winner ? short(agent.winner) : "—";

  return (
    <div className="arena">
      <LangToggle />
      <div className="arena-top">
        <div>
          <div className="brand">
            <span className="ball">⚽</span> {t("brand")}
          </div>
          <div className="tagline">{t("tagline")} · {t("subtitle")}</div>
        </div>
        {phase === PHASES.LIVE && (
          <div className="live-pill">
            <span className="dot" /> {t("live")}
          </div>
        )}
      </div>

      <div className="arena-body">
        <div className="qr-col">
          <div className="qr-card">
            <h3>{t("scanToPlay")}</h3>
            <p>{t("scanHint")}</p>
            <div className="qr-frame">
              <QRCodeSVG value={BOT_URL || window.location.origin} size={210} level="M" />
            </div>
          </div>

          <div className="prize-card">
            <div className="label">{t("onSale")}</div>
            <div className="name">{itemName || "—"}</div>
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
                const isWin =
                  (phase === PHASES.WINNER || phase === PHASES.REVEAL) && i === winnerIndex;
                return (
                  <div key={o.txHash || i} className={`offer-card ${isWin ? "win" : ""}`}>
                    <div className="top">
                      <span className="who">{isWin ? "👑 " : ""}{short(o.buyer)}</span>
                      <span className="amt">≤ {num(o.maxBudgetMcop)}</span>
                    </div>
                    <div className="arg">{o.request}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

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
            <div className="who">{winnerName}</div>
            <div className="bid">
              {t("paid")}: {num(agent?.finalPriceMcop)} {t("mcop")}
            </div>
            {agent?.savingsMcop != null && (
              <div className="savings">
                💸 {t("saved")} {num(agent.savingsMcop)} {t("mcop")} ({t("maxWas")}{" "}
                {num(agent.maxBudgetMcop)})
              </div>
            )}
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
                <div className="lbl">{t("reserve")}</div>
                <div className="v">{num(reveal.reserveMcop)}</div>
              </div>
              <div className="reveal-num bid">
                <div className="lbl">{t("finalPrice")}</div>
                <div className="v">{num(reveal.finalPriceMcop)}</div>
              </div>
              <div className="reveal-num spread">
                <div className="lbl">{t("margin")}</div>
                <div className="v">
                  {Number(reveal.marginMcop) >= 0 ? "+" : ""}
                  {num(reveal.marginMcop)}
                </div>
              </div>
            </div>
            <div className="spread-note">
              {t("marginOver")} · {t("mcop")}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
