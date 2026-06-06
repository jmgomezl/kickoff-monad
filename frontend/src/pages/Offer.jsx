import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import WebApp from "@twa-dev/sdk";
import LangToggle from "../components/LangToggle.jsx";
import { BACKEND_URL } from "../config.js";

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
  const [listing, setListing] = useState(null);
  const [wallet, setWallet] = useState(null); // {address, balanceMcop}
  const [joining, setJoining] = useState(true);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const userId = useRef(null);

  useEffect(() => {
    try {
      WebApp.ready();
      WebApp.expand();
    } catch (_) {}
    userId.current = resolveUserId();

    (async () => {
      // Kick off wallet creation + airdrop and active-listing fetch in parallel.
      const join = fetch(`${BACKEND_URL}/api/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: userId.current }),
      })
        .then((r) => r.json())
        .then((w) => setWallet(w))
        .catch(() => {})
        .finally(() => setJoining(false));

      fetch(`${BACKEND_URL}/api/active`)
        .then((r) => r.json())
        .then((r) => setListing(r.active || null))
        .catch(() => setListing(null));

      await join;
    })();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => clearInterval(id);
  }, []);

  const secsLeft = listing?.deadline ? Math.max(0, listing.deadline - now) : null;
  const closed = secsLeft === 0;

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
        body: JSON.stringify({
          userId: userId.current,
          listingId: listing.listingId,
          text: text.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
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
          <div className="check">✓</div>
          <h2>{t("offerSent")}</h2>
          <p>{t("offerSentSub")}</p>
          <button className="btn secondary" onClick={() => setSent(false)}>
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
      <div className="balance-chip">
        <span className="coin">🪙</span>
        <span className="lbl">{t("yourBalance")}</span>
        <span className="val">
          {joining ? "…" : Number(wallet?.balanceMcop || 0).toLocaleString()} {t("mcop")}
        </span>
      </div>

      {listing && (
        <div className="prize-banner">
          <div className="emoji">⚽</div>
          <div className="label">{t("onSale")}</div>
          <div className="name">{listing.itemName}</div>
          {secsLeft != null && <div className="countdown-mini">⏱ {secsLeft}s</div>}
        </div>
      )}

      {!listing ? (
        <div className="center-screen">{joining ? t("preparingWallet") : t("noActiveArena")}</div>
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

          <button className="btn" type="submit" disabled={submitting || closed || !text.trim()}>
            {submitting ? t("sending") : `🤖 ${t("send")}`}
          </button>
        </form>
      )}

      <div className="foot">⚡ {t("poweredBy")}</div>
    </div>
  );
}
