import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import WebApp from "@twa-dev/sdk";
import LangToggle from "../components/LangToggle.jsx";
import { BACKEND_URL, explorerAddress } from "../config.js";

const TEXT_MAX = 500;

// Stable per-device id for browser testing; Telegram user id inside the Mini App.
function resolveUserId() {
  try {
    const u = WebApp.initDataUnsafe?.user;
    if (u?.id) return `tg-${u.id}`;
  } catch (_) {}
  let id = localStorage.getItem("kickoff_uid");
  if (!id) {
    id = "web-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("kickoff_uid", id);
  }
  return id;
}

export default function Offer() {
  const { t } = useTranslation();
  const uid = useMemo(() => resolveUserId(), []);
  const [listing, setListing] = useState(null);
  const [balance, setBalance] = useState(null); // number once known
  const [wallet, setWallet] = useState(null); // {address, monBalance}
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [result, setResult] = useState(null); // {won, price, savings}
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const submittedRef = useRef(null); // listingId the buyer last submitted an offer on

  // If a NEW deal goes live before the buyer ever got their result, move them to
  // the fresh deal's offer form. But once a result is shown, keep it on screen
  // (they dismiss it via "send another") so a winner never loses their "ganaste".
  useEffect(() => {
    const id = listing?.listingId;
    if (sent && !result && submittedRef.current && id && id !== submittedRef.current) {
      setSent(false);
      setText("");
      submittedRef.current = null;
    }
  }, [listing?.listingId, sent, result]);

  // Telegram init + kick off wallet creation/airdrop + fetch active listing.
  useEffect(() => {
    try {
      WebApp.ready();
      WebApp.expand();
    } catch (_) {}

    // Fire join (creates wallet + airdrops 50k + gas). Don't block the UI on it —
    // the balance poll below will surface the balance as soon as funding lands.
    fetch(`${BACKEND_URL}/api/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: uid }),
    })
      .then((r) => r.json())
      .then((w) => {
        if (w?.balanceMcop != null) setBalance(Number(w.balanceMcop));
        if (w?.address) setWallet((p) => ({ ...(p || {}), address: w.address }));
      })
      .catch(() => {});
  }, [uid]);

  // Keep the active deal fresh: poll, and refresh the moment the app regains
  // focus (so users never have to close/reopen to see if a deal is available).
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${BACKEND_URL}/api/active`)
        .then((r) => r.json())
        .then((r) => alive && setListing(r.active || null))
        .catch(() => {});
    load();
    const id = setInterval(load, 4000);
    const onVis = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", load);
    };
  }, []);

  // Poll the wallet balance independently of the (slow) join response.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const w = await fetch(`${BACKEND_URL}/api/wallet/${uid}`).then((r) => r.json());
        if (alive && w?.address && w.balanceMcop != null) {
          setBalance(Number(w.balanceMcop));
          setWallet({ address: w.address, monBalance: w.monBalance });
        }
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [uid]);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => clearInterval(id);
  }, []);

  // Buyer history (on-chain). Refresh on mount and whenever a deal resolves.
  useEffect(() => {
    let alive = true;
    fetch(`${BACKEND_URL}/api/history/${uid}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setHistory(d.items || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [uid, sent, result]);

  // After submitting, poll the deal the buyer ACTUALLY offered on (not whatever
  // is currently active) to surface their result in-app. Using the live listing
  // is wrong when deals run back-to-back: the winner of deal A would be judged
  // against deal B and shown "you lost".
  useEffect(() => {
    const offeredOn = submittedRef.current;
    if (!sent || !offeredOn) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetch(`${BACKEND_URL}/api/listing/${offeredOn}`).then((r) => r.json());
        if (!alive || !s || s.state < 2 || !wallet?.address) return;
        const w = s.offers?.[s.winnerIndex];
        const me = wallet.address.toLowerCase();
        const won = !!w && w.buyer?.toLowerCase() === me;
        const price = Number(s.finalPriceMcop || 0);
        const savings = won ? Math.max(0, Number(w.maxBudgetMcop) - price) : 0;
        setResult({ won, price, savings });
        try {
          WebApp.HapticFeedback?.notificationOccurred(won ? "success" : "warning");
        } catch (_) {}
      } catch (_) {}
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [sent, wallet]);

  const ready = balance != null; // wallet funded / balance known
  const secsLeft = listing?.deadline ? Math.max(0, listing.deadline - now) : null;
  const closed = secsLeft === 0;
  const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  function copyAddr() {
    if (!wallet?.address) return;
    try {
      navigator.clipboard.writeText(wallet.address);
    } catch (_) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!listing) return setError(t("noActiveArena"));
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/offer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: uid, listingId: listing.listingId, text: text.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      submittedRef.current = listing.listingId;
      setSent(true);
      try {
        WebApp.HapticFeedback?.notificationOccurred("success");
      } catch (_) {}
    } catch (err) {
      setError(err.message || t("errorGeneric"));
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <div className="offer-page">
        <LangToggle />
        <div className="success">
          {!result ? (
            <>
              <div className="check waiting">⏳</div>
              <h2>{t("offerSent")}</h2>
              <p>{t("inPlay")}</p>
            </>
          ) : result.won ? (
            <>
              <div className="check win">🏆</div>
              <h2>{t("youWon")}</h2>
              <p>
                {t("wonSub", {
                  price: result.price.toLocaleString(),
                  savings: result.savings.toLocaleString(),
                })}
              </p>
            </>
          ) : (
            <>
              <div className="check lose">🤝</div>
              <h2>{t("youLost")}</h2>
              <p>{t("lostSub", { price: result.price.toLocaleString() })}</p>
            </>
          )}
          {text && <div className="your-story">“{text}”</div>}
          <button
            className="btn secondary"
            onClick={() => {
              setSent(false);
              setResult(null);
              setText("");
            }}
          >
            {t("sendAnother")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="offer-page">
      <LangToggle />
      <div className="offer-header">
        <div className="brand">
          <span className="ball">⚽</span> {t("brand")}
        </div>
        <div className="tagline">{t("tagline")}</div>
      </div>

      {/* Balance chip */}
      <div className={`balance-chip ${ready ? "" : "loading"}`}>
        <span className="coin">🪙</span>
        {ready ? (
          <>
            <span className="lbl">{t("yourBalance")}</span>
            <span className="val">{balance.toLocaleString()} {t("mcop")}</span>
          </>
        ) : (
          <span className="lbl pulse">{t("preparingWallet")}</span>
        )}
      </div>

      {/* Agent-created, KMS-managed wallet */}
      {wallet?.address && (
        <div className="wallet-card">
          <div className="wc-top">
            <span className="wc-label">{t("yourWallet")}</span>
            <span className="wc-kms">{t("securedKms")}</span>
          </div>
          <div className="wc-addr">
            <code>{shortAddr(wallet.address)}</code>
            <button type="button" className="wc-btn" onClick={copyAddr}>
              {copied ? t("copied") : t("copy")}
            </button>
            <a
              className="wc-btn"
              href={explorerAddress(wallet.address)}
              target="_blank"
              rel="noreferrer"
            >
              {t("viewOnExplorer")} ↗
            </a>
          </div>
          <div className="wc-sub">
            🤖 {t("agentManaged")}
            {wallet.monBalance != null && (
              <> · {t("gasLabel")}: {Number(wallet.monBalance).toFixed(2)} MON</>
            )}
          </div>
        </div>
      )}

      {listing && (
        <div className="prize-banner">
          <div className="emoji">⚽</div>
          <div className="label">{t("onSale")}</div>
          <div className="name">{listing.itemName}</div>
          {secsLeft != null && <div className="countdown-mini">⏱ {secsLeft}s</div>}
        </div>
      )}

      {!listing ? (
        <div className="center-screen">{t("noActiveArena")}</div>
      ) : closed ? (
        <div className="center-screen">{t("dealClosed")}</div>
      ) : (
        <form className="offer-form chat" onSubmit={submit}>
          <label className="chat-title">{t("describeTitle")}</label>
          <textarea
            className="chat-input"
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, TEXT_MAX))}
            placeholder={t("describePh")}
            rows={6}
            autoFocus
          />
          <div className="chat-foot">
            <span className="hint">{t("hintBudget")}</span>
            <span className="count">
              {text.length}/{TEXT_MAX}
            </span>
          </div>

          {error && <div className="error-text">{error}</div>}

          <button
            className="btn"
            type="submit"
            disabled={submitting || closed || !text.trim() || !ready}
          >
            {submitting ? t("sending") : !ready ? t("preparingWallet") : `🤖 ${t("send")}`}
          </button>
        </form>
      )}

      {history.length > 0 && (
        <div className="activity">
          <button className="activity-toggle" onClick={() => setShowHistory((s) => !s)}>
            📜 {t("myActivity")} ({history.length}) <span>{showHistory ? "▲" : "▼"}</span>
          </button>
          {showHistory && (
            <div className="activity-list">
              {history.map((h) => (
                <div
                  key={h.listingId}
                  className={`activity-item ${h.won ? "won" : h.decided ? "lost" : "open"}`}
                >
                  <div className="ai-top">
                    <span className="ai-name">{h.itemName}</span>
                    <span className={`ai-badge ${h.won ? "won" : h.decided ? "lost" : "open"}`}>
                      {h.won ? `🏆 ${t("histWon")}` : h.decided ? t("histLost") : t("histOpen")}
                    </span>
                  </div>
                  <div className="ai-sub">
                    {h.won
                      ? `${t("histPaid")} ${Number(h.finalPriceMcop).toLocaleString()} MONADCOP`
                      : `${t("histCap")}: ${Number(h.maxBudgetMcop).toLocaleString()} MONADCOP`}
                  </div>
                  {h.won && h.reasoning && <div className="ai-reason">🤖 {h.reasoning}</div>}
                  {h.explorerUrl && (
                    <a className="ai-tx" href={h.explorerUrl} target="_blank" rel="noreferrer">
                      {t("viewOnExplorer")} ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="foot">⚡ {t("poweredBy")}</div>
    </div>
  );
}
