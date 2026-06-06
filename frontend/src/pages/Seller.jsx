import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import LangToggle from "../components/LangToggle.jsx";
import { BACKEND_URL } from "../config.js";

const STATE = {
  1: { es: "Abierto", en: "Open", cls: "open" },
  2: { es: "Vendido", en: "Sold", cls: "won" },
  3: { es: "Revelado", en: "Revealed", cls: "won" },
  4: { es: "Cancelado", en: "Cancelled", cls: "lost" },
};
const num = (v) => Number(v || 0).toLocaleString();

export default function Seller() {
  const { i18n } = useTranslation();
  const es = !i18n.language?.startsWith("en");
  const [listings, setListings] = useState([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${BACKEND_URL}/api/listings`)
        .then((r) => r.json())
        .then((d) => alive && setListings(d.listings || []))
        .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const sold = listings.filter((l) => l.state >= 2);
  const totalSold = sold.reduce((s, l) => s + Number(l.finalPriceMcop || 0), 0);

  return (
    <div className="seller-page">
      <LangToggle />
      <div className="offer-header">
        <div className="brand">
          <span className="ball">⚽</span> KICKOFF · {es ? "ventas" : "sales"}
        </div>
        <div className="tagline">{es ? "Lo que vendió el agente" : "What the agent sold"}</div>
      </div>

      <div className="seller-summary">
        <div>
          <div className="ss-num">{sold.length}</div>
          <div className="ss-lbl">{es ? "vendidos" : "sold"}</div>
        </div>
        <div>
          <div className="ss-num green">{num(totalSold)}</div>
          <div className="ss-lbl">MONADCOP</div>
        </div>
        <div>
          <div className="ss-num">{listings.length}</div>
          <div className="ss-lbl">{es ? "tratos" : "deals"}</div>
        </div>
      </div>

      <div className="seller-list">
        {listings.map((l) => {
          const st = STATE[l.state] || STATE[1];
          return (
            <div key={l.listingId} className={`activity-item ${st.cls}`}>
              <div className="ai-top">
                <span className="ai-name">
                  #{l.listingId} · {l.itemName}
                </span>
                <span className={`ai-badge ${st.cls}`}>{es ? st.es : st.en}</span>
              </div>
              <div className="ai-sub">
                {l.state >= 2 ? (
                  <>
                    {es ? "Vendido en" : "Sold for"} <b>{num(l.finalPriceMcop)}</b> MONADCOP
                    {l.revealedReserveMcop != null && (
                      <>
                        {" · "}
                        {es ? "reserva" : "reserve"} {num(l.revealedReserveMcop)}
                        {" · "}
                        {es ? "margen" : "margin"} {Number(l.marginMcop) >= 0 ? "+" : ""}
                        {num(l.marginMcop)}
                      </>
                    )}
                  </>
                ) : (
                  `${l.offerCount} ${es ? "ofertas" : "offers"}`
                )}
              </div>
              {l.reasoning && <div className="ai-reason">🤖 {l.reasoning}</div>}
              {l.explorerUrl && (
                <a className="ai-tx" href={l.explorerUrl} target="_blank" rel="noreferrer">
                  {es ? "Ver transferencia" : "View transfer"} ↗
                </a>
              )}
            </div>
          );
        })}
        {listings.length === 0 && (
          <div className="center-screen">{es ? "Aún no hay tratos." : "No deals yet."}</div>
        )}
      </div>
    </div>
  );
}
