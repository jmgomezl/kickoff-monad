import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BACKEND_URL } from "../config.js";

// Floating operator control on the arena: set the API key + timer, start a deal,
// and reveal — without leaving the big-screen view. Collapsed by default.
export default function ArenaControls({ listingId }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState(() => localStorage.getItem("kickoff_admin") || "");
  const [itemName, setItemName] = useState("Balón oficial Monad Blitz");
  const [reserve, setReserve] = useState(15000);
  const [duration, setDuration] = useState(90);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  function saveToken(v) {
    setToken(v);
    localStorage.setItem("kickoff_admin", v);
  }

  async function call(path, body) {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`${BACKEND_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "error");
      return data;
    } catch (e) {
      setMsg("⚠️ " + e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    const d = await call("/api/admin/create-listing", {
      itemName,
      reserveMcop: String(reserve),
      durationSec: Number(duration),
    });
    if (d) setMsg(`✅ Trato #${d.listingId} · ${d.durationSec}s`);
  }

  async function reveal() {
    if (!listingId) return setMsg("⚠️ sin trato activo");
    const d = await call("/api/admin/reveal", { listingId });
    if (d) setMsg(`🎭 Reserva revelada`);
  }

  if (!open) {
    return (
      <button className="op-fab" onClick={() => setOpen(true)} title={t("opPanel")} aria-label="control">
        ⚙️
      </button>
    );
  }

  return (
    <div className="op-panel">
      <div className="op-head">
        <span>🎛️ {t("opPanel")}</span>
        <button className="op-x" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>

      <label className="op-lbl">{t("opToken")}</label>
      <input
        className="op-input"
        type="password"
        value={token}
        onChange={(e) => saveToken(e.target.value)}
        placeholder="x-admin-token"
      />

      <label className="op-lbl">{t("opItem")}</label>
      <input className="op-input" value={itemName} onChange={(e) => setItemName(e.target.value)} />

      <div className="op-row">
        <div style={{ flex: 1 }}>
          <label className="op-lbl">{t("opReserve")}</label>
          <input
            className="op-input"
            type="number"
            value={reserve}
            onChange={(e) => setReserve(e.target.value)}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label className="op-lbl">
            {t("opDuration")}: <b>{duration}s</b>
          </label>
          <input
            type="range"
            min="20"
            max="300"
            step="5"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--purple)" }}
          />
        </div>
      </div>
      <div className="op-presets">
        {[30, 60, 90, 120, 180].map((s) => (
          <button key={s} className={`op-preset ${duration === s ? "on" : ""}`} onClick={() => setDuration(s)}>
            {s}s
          </button>
        ))}
      </div>

      <div className="op-actions">
        <button className="op-btn start" disabled={busy || !token} onClick={start}>
          ▶️ {t("opStart")}
        </button>
        <button className="op-btn reveal" disabled={busy || !token || !listingId} onClick={reveal}>
          🎭 {t("opReveal")}
        </button>
      </div>
      {msg && <div className="op-msg">{msg}</div>}
    </div>
  );
}
