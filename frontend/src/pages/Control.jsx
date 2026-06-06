import { useEffect, useState } from "react";
import LangToggle from "../components/LangToggle.jsx";
import { BACKEND_URL, explorerTx } from "../config.js";

// Operator control panel — set the timer and start a deal, then reveal.
export default function Control() {
  const [token, setToken] = useState(() => localStorage.getItem("kickoff_admin") || "");
  const [itemName, setItemName] = useState("Balón oficial Monad Blitz");
  const [reserve, setReserve] = useState(15000);
  const [duration, setDuration] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [last, setLast] = useState(null); // {listingId, txHash, deadline}
  const [active, setActive] = useState(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    const poll = setInterval(refreshActive, 3000);
    refreshActive();
    return () => {
      clearInterval(t);
      clearInterval(poll);
    };
  }, []);

  function refreshActive() {
    fetch(`${BACKEND_URL}/api/active`)
      .then((r) => r.json())
      .then((r) => setActive(r.active || null))
      .catch(() => {});
  }

  function saveToken(v) {
    setToken(v);
    localStorage.setItem("kickoff_admin", v);
  }

  async function start() {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/admin/create-listing`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ itemName, reserveMcop: String(reserve), durationSec: Number(duration) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      setLast(data);
      refreshActive();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    if (!last?.listingId) return;
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/admin/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": token },
        body: JSON.stringify({ listingId: last.listingId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed");
      setLast((l) => ({ ...l, revealTx: data.txHash }));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const activeLeft = active?.deadline ? Math.max(0, active.deadline - now) : null;

  return (
    <div className="control-page">
      <LangToggle />
      <div className="offer-header">
        <div className="brand">
          <span className="ball">⚽</span> KICKOFF · control
        </div>
        <div className="tagline">Panel del operador</div>
      </div>

      <div className="ctrl-card">
        <label className="field-lbl">Admin token</label>
        <input
          className="ctrl-input"
          type="password"
          value={token}
          onChange={(e) => saveToken(e.target.value)}
          placeholder="x-admin-token"
        />
      </div>

      <div className="ctrl-card">
        <label className="field-lbl">Artículo</label>
        <input className="ctrl-input" value={itemName} onChange={(e) => setItemName(e.target.value)} />

        <label className="field-lbl">Reserva oculta (MONADCOP)</label>
        <input
          className="ctrl-input"
          type="number"
          value={reserve}
          onChange={(e) => setReserve(e.target.value)}
        />

        <label className="field-lbl">
          Duración: <b>{duration}s</b>
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
        <div className="ctrl-presets">
          {[30, 60, 90, 120, 180].map((s) => (
            <button key={s} className="preset" onClick={() => setDuration(s)}>
              {s}s
            </button>
          ))}
        </div>

        {error && <div className="error-text">{error}</div>}

        <button className="btn" disabled={busy || !token} onClick={start}>
          {busy ? "…" : "▶️ Iniciar trato"}
        </button>
      </div>

      {last && (
        <div className="ctrl-card">
          <div className="ctrl-status">
            ✅ Listing #{last.listingId} creado ·{" "}
            <a href={explorerTx(last.txHash)} target="_blank" rel="noreferrer">
              tx ↗
            </a>
          </div>
          <button className="btn secondary" disabled={busy} onClick={reveal}>
            🎭 Revelar reserva (tras la decisión)
          </button>
          {last.revealTx && (
            <div className="ctrl-status">
              Revelado ·{" "}
              <a href={explorerTx(last.revealTx)} target="_blank" rel="noreferrer">
                tx ↗
              </a>
            </div>
          )}
        </div>
      )}

      <div className="ctrl-card">
        <div className="ctrl-status">
          {active
            ? `🟢 Activo: #${active.listingId} "${active.itemName}" — ${activeLeft}s`
            : "⚪ Sin trato activo"}
        </div>
        <div className="ctrl-links">
          <a href="/arena" target="_blank" rel="noreferrer">
            Abrir feed (arena) ↗
          </a>
        </div>
      </div>
    </div>
  );
}
