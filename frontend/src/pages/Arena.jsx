import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import LangToggle from "../components/LangToggle.jsx";
import PixelAvatar from "../components/PixelAvatar.jsx";
import ArenaControls from "../components/ArenaControls.jsx";
import { useArena } from "../useArena.js";
import { BOT_URL, explorerTx, explorerAddress, IDENTITY_REGISTRY, AGENT_ID } from "../config.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");
const num = (v) => Number(v || 0).toLocaleString();

const TX_META = {
  listing: { icon: "🟣", key: "txListing" },
  offer: { icon: "💸", key: "txOffer" },
  exec: { icon: "🤖", key: "txExec" },
  pay: { icon: "💰", key: "txPay" },
  reveal: { icon: "🎭", key: "txReveal" },
};

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

// Plays the seller-agent ↔ buyer-agents negotiation line by line.
function Negotiation({ dialogue = [], reasoning, t }) {
  const [shown, setShown] = useState(1);
  const endRef = useRef(null);
  useEffect(() => {
    if (shown >= dialogue.length) return;
    const id = setTimeout(() => setShown((s) => s + 1), 2200);
    return () => clearTimeout(id);
  }, [shown, dialogue.length]);
  const allShown = shown >= dialogue.length;
  // Keep the newest line in view as the negotiation plays out (and when the
  // verdict lands), so a long conversation never scrolls out of sight.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [shown, allShown]);
  return (
    <div className="negotiation">
      <div className="kicker">🤝 {t("negotiation")}</div>
      <div className="nego-feed">
        {dialogue.slice(0, shown).map((d, i) => {
          const isSeller = d.role === "seller";
          return (
            <div key={i} className={`nego-line ${isSeller ? "seller" : "buyer"}`}>
              <div className="nego-who">
                <PixelAvatar
                  seed={isSeller ? "kickoff-seller-agent" : d.who || "buyer-agent"}
                  size={34}
                  accent={isSeller ? "#ffd166" : undefined}
                />
                <span>{isSeller ? t("sellerAgent") : d.who || t("buyerAgent")}</span>
              </div>
              <div className="nego-bubble">{d.text}</div>
            </div>
          );
        })}
      </div>
      {allShown && reasoning && <div className="nego-verdict">⚖️ {reasoning}</div>}
      <div className="nego-tech">
        🔒 Billeteras AWS&nbsp;KMS · 🤖 gpt-5-mini · ⚡ Monad · finalidad 0.4s · 🔗 on-chain
        {AGENT_ID ? ` · 🆔 ERC-8004 #${AGENT_ID}` : ""}
      </div>
      <div ref={endRef} />
    </div>
  );
}

export default function Arena() {
  const { t } = useTranslation();
  const [ctrlOpen, setCtrlOpen] = useState(false);
  const { listingId, itemName, deadline, offers, phase, agent, reveal, attitude, txs, replaying, PHASES } =
    useArena();
  const ATT_KEY = { humano: "attHumano", equilibrado: "attEquilibrado", agresivo: "attAgresivo" };
  const { secs } = useCountdown(deadline);

  // Let the operator dismiss the reasoning/winner/reveal overlay when they're
  // done with it; it re-appears automatically on the next phase change.
  const [overlayHidden, setOverlayHidden] = useState(false);
  useEffect(() => setOverlayHidden(false), [phase]);

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
  // Sealed-bid: offers stay hidden until the deal closes and the agent evaluates.
  const sealed = phase === PHASES.WAITING || phase === PHASES.LIVE;
  const totalSecs = useMemo(() => 90, []);
  const pct = secs != null ? Math.min(100, (secs / totalSecs) * 100) : 0;
  const winnerName = agent?.winner ? short(agent.winner) : "—";

  return (
    <div className="arena">
      <LangToggle />
      <ArenaControls listingId={listingId} open={ctrlOpen} onClose={() => setCtrlOpen(false)} />
      <div className="arena-top">
        <div>
          <div className="brand">
            <span className="ball">⚽</span> {t("brand")}
          </div>
          <div className="tagline">{t("tagline")} · {t("subtitle")}</div>
          {AGENT_ID && (
            <a
              className="agent-id-badge"
              href={IDENTITY_REGISTRY ? explorerAddress(IDENTITY_REGISTRY) : "#"}
              target="_blank"
              rel="noreferrer"
              title={t("agentIdTitle")}
            >
              🆔 ERC-8004 · {t("agentLabel")} #{AGENT_ID} ↗
            </a>
          )}
        </div>
        <div className="arena-status">
          {replaying && (
            <div className="live-pill deliberating">
              ↻ {t("replay")}
            </div>
          )}
          {phase === PHASES.LIVE && !replaying && (
            <div className="live-pill">
              <span className="dot" /> {t("live")}
            </div>
          )}
          {phase === PHASES.EVALUATING && (
            <div className="live-pill deliberating">
              <span className="spin-sm" /> {t("deliberating")}
            </div>
          )}
          <button
            className="op-gear"
            onClick={() => setCtrlOpen(true)}
            title={t("opPanel")}
            aria-label={t("opPanel")}
          >
            ⚙️
          </button>
        </div>
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
            {attitude && ATT_KEY[attitude] && (
              <div className="att-badge">{t("opAttitude")}: {t(ATT_KEY[attitude])}</div>
            )}
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
            <div>
              <h2>{t("offersIn")}</h2>
              {sealed && offers.length > 0 && <div className="sealed-hint">{t("offersSealed")}</div>}
              {phase === PHASES.EVALUATING && (
                <div className="sealed-hint reading">{t("readingOffers")}</div>
              )}
            </div>
            <div className="offers-count">{offers.length}</div>
          </div>
          {offers.length === 0 ? (
            <div className="empty-offers">{t("waitingOffers")}</div>
          ) : (
            <div className="offers-grid">
              {offers.map((o, i) => {
                const isWin =
                  (phase === PHASES.WINNER || phase === PHASES.REVEAL) && i === winnerIndex;
                // Sealed-bid: hide budget + argument while the deal is open.
                if (sealed) {
                  return (
                    <div key={o.txHash || i} className="offer-card sealed">
                      <div className="top">
                        <span className="who">🔒 {t("offerN", { n: i + 1 })}</span>
                        <span className="amt sealed-amt">≤ ••••</span>
                      </div>
                      <div className="arg sealed-text">{t("sealedOffer")}</div>
                    </div>
                  );
                }
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

      {/* On-chain transaction ticker — real Monad activity for the audience. */}
      {txs.length > 0 && (
        <div className="arena-txbar">
          <span className="txbar-title">⛓ {t("onchain")}</span>
          <div className="txbar-list">
            {txs.slice(-6).map((tx) => {
              const m = TX_META[tx.kind] || { icon: "🔗", key: "onchain" };
              return (
                <a
                  key={tx.txHash}
                  className={`tx-chip ${tx.kind}`}
                  href={explorerTx(tx.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="tx-ic">{m.icon}</span>
                  <span className="tx-lbl">
                    {t(m.key)}
                    {tx.amount ? ` · ${num(tx.amount)}` : ""}
                  </span>
                  <span className="tx-hash">{short(tx.txHash)} ↗</span>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* During EVALUATING we deliberately do NOT cover the screen — the offers
          unseal and stay visible so the crowd reads every pitch while the agent
          deliberates. The reasoning/winner/reveal overlays come after. */}

      {phase === PHASES.REASONING && !overlayHidden && (
        <div className="overlay">
          <button className="overlay-close" onClick={() => setOverlayHidden(true)} aria-label="cerrar">
            ✕
          </button>
          {agent?.noOffers ? (
            <div className="reasoning-panel">
              <div className="kicker">🤖 {t("agentReasoning")}</div>
              <div className="text">{t("noOffers")}</div>
            </div>
          ) : agent?.dialogue?.length ? (
            <Negotiation dialogue={agent.dialogue} reasoning={agent.reasoning} t={t} />
          ) : (
            <div className="reasoning-panel">
              <div className="kicker">🤖 {t("agentReasoning")}</div>
              <div className="text typewriter">{typed}</div>
            </div>
          )}
        </div>
      )}

      {phase === PHASES.WINNER && !overlayHidden && (
        <div className="overlay winner">
          <button className="overlay-close" onClick={() => setOverlayHidden(true)} aria-label="cerrar">
            ✕
          </button>
          <Confetti />
          <div>
            <div className="crown">👑</div>
            <h1>
              <span className="brand" style={{ letterSpacing: 4 }}>
                {t("winnerIs")}
              </span>
            </h1>
            <div className="winner-avatar">
              <PixelAvatar seed={agent?.winner || winnerName} size={96} />
            </div>
            <div className="who">{winnerName}</div>
            {offers[winnerIndex]?.request && (
              <div className="winner-story">“{offers[winnerIndex].request}”</div>
            )}
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

      {phase === PHASES.REVEAL && reveal && !overlayHidden && (
        <div className="overlay reveal">
          <button className="overlay-close" onClick={() => setOverlayHidden(true)} aria-label="cerrar">
            ✕
          </button>
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
