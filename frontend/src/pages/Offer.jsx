import { useEffect, useMemo, useState } from "react";
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
  const uid = useMemo(() => resolveUserId(), []);
  const [listing, setListing] = useState(null);
  const [balance, setBalance] = useState(null); // number once known
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

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
      })
      .catch(() => {});

    fetch(`${BACKEND_URL}/api/active`)
      .then((r) => r.json())
      .then((r) => setListing(r.active || null))
      .catch(() => setListing(null));
  }, [uid]);

  // Poll the wallet balance independently of the (slow) join response.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const w = await fetch(`${BACKEND_URL}/api/wallet/${uid}`).then((r) => r.json());
        if (alive && w?.address && w.balanceMcop != null) setBalance(Number(w.balanceMcop));
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

  const ready = balance != null; // wallet funded / balance known
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
        body: JSON.stringify({ userId: uid, listingId: listing.listingId, text: text.trim() }),
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

      <div className="foot">⚡ {t("poweredBy")}</div>
    </div>
  );
}
