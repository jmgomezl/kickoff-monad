import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import WebApp from "@twa-dev/sdk";
import LangToggle from "../components/LangToggle.jsx";
import { BACKEND_URL } from "../config.js";

const ARG_MAX = 280;

export default function Offer() {
  const { t } = useTranslation();
  const [arena, setArena] = useState(null); // {arenaId, prizeName, deadline}
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState(0.01);
  const [argument, setArgument] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Telegram init.
  useEffect(() => {
    try {
      WebApp.ready();
      WebApp.expand();
      const u = WebApp.initDataUnsafe?.user;
      if (u) setName([u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "");
    } catch (_) {
      /* not inside Telegram — fine for browser testing */
    }
  }, []);

  // Fetch active arena.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/active`).then((x) => x.json());
        if (alive) setArena(r.active || null);
      } catch (_) {
        if (alive) setArena(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => clearInterval(id);
  }, []);

  const secsLeft = arena?.deadline ? Math.max(0, arena.deadline - now) : null;
  const closed = secsLeft === 0;

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!arena) return setError(t("noActiveArena"));
    if (!argument.trim()) return setError(t("errorGeneric"));
    setSubmitting(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/offer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          arenaId: arena.arenaId,
          name: name.trim() || "Anónimo",
          amountMon: amount,
          argument: argument.trim(),
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

  function reset() {
    setSent(false);
    setArgument("");
    setError("");
  }

  if (loading) {
    return (
      <div className="center-screen">
        <div className="brand">
          <span className="ball">⚽</span> KICKOFF
        </div>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="offer-page">
        <LangToggle />
        <div className="success">
          <div className="check">✓</div>
          <h2>{t("offerSent")}</h2>
          <p>{t("offerSentSub")}</p>
          <button className="btn secondary" onClick={reset}>
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

      <div className="prize-banner">
        <div className="emoji">⚽</div>
        <div className="label">{t("prizeLabel")}</div>
        <div className="name">{arena?.prizeName || "—"}</div>
        {secsLeft != null && (
          <div className="countdown-mini">⏱ {secsLeft}s</div>
        )}
      </div>

      {!arena ? (
        <div className="center-screen">{t("noActiveArena")}</div>
      ) : (
        <form className="offer-form" onSubmit={submit}>
          <div className="field">
            <label>{t("yourName")}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("yourNamePh")}
              maxLength={40}
            />
          </div>

          <div className="field">
            <label>{t("offerAmount")}</label>
            <div className="amount-row">
              <input
                type="range"
                min="0.001"
                max="0.05"
                step="0.001"
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
              <span className="amount-pill">{amount.toFixed(3)} MON</span>
            </div>
          </div>

          <div className="field">
            <label>{t("yourArgument")}</label>
            <textarea
              value={argument}
              onChange={(e) => setArgument(e.target.value.slice(0, ARG_MAX))}
              placeholder={t("yourArgumentPh")}
            />
            <div className="hint">
              {ARG_MAX - argument.length} {t("charsLeft")}
            </div>
          </div>

          {error && <div className="error-text">{error}</div>}

          <button className="btn" type="submit" disabled={submitting || closed}>
            {submitting ? t("submitting") : t("submit")}
          </button>
        </form>
      )}

      <div className="foot">⚡ {t("poweredBy")}</div>
    </div>
  );
}
