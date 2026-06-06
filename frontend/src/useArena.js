import { useEffect, useRef, useState, useCallback } from "react";
import { BACKEND_URL, WS_URL } from "./config";

/**
 * Subscribes to the backend WebSocket and reduces the KickoffMarket event
 * stream into a single view-model for the big-screen feed.
 */
const PHASES = {
  WAITING: "waiting",
  LIVE: "live",
  EVALUATING: "evaluating",
  REASONING: "reasoning",
  WINNER: "winner",
  REVEAL: "reveal",
};

export function useArena() {
  const [listingId, setListingId] = useState(null);
  const [itemName, setItemName] = useState("");
  const [deadline, setDeadline] = useState(null);
  const [offers, setOffers] = useState([]);
  const [phase, setPhase] = useState(PHASES.WAITING);
  const [agent, setAgent] = useState(null);
  const [reveal, setReveal] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  const apply = useCallback((e) => {
    switch (e.type) {
      case "listing_created":
        setListingId(e.listingId);
        setItemName(e.itemName);
        setDeadline(e.deadline);
        setOffers([]);
        setAgent(null);
        setReveal(null);
        setPhase(PHASES.LIVE);
        break;
      case "offer_submitted":
        setOffers((prev) => {
          if (prev.some((o) => o.txHash && o.txHash === e.txHash)) return prev;
          return [...prev, e];
        });
        setPhase((p) => (p === PHASES.WAITING ? PHASES.LIVE : p));
        break;
      case "agent_evaluating":
        setPhase(PHASES.EVALUATING);
        break;
      case "agent_no_offers":
        setAgent({ noOffers: true });
        setPhase(PHASES.REASONING);
        break;
      case "agent_reasoning":
        setAgent((a) => ({ ...(a || {}), ...e }));
        setPhase(PHASES.REASONING);
        break;
      case "agent_executing":
        setAgent((a) => ({ ...(a || {}), txHash: e.txHash, executing: true }));
        break;
      case "winner_chosen":
        setAgent((a) => ({ ...(a || {}), ...e, executing: false }));
        setPhase(PHASES.WINNER);
        break;
      case "reserve_revealed":
        setReveal(e);
        setPhase(PHASES.REVEAL);
        break;
      default:
        break;
    }
  }, []);

  // Hydrate latest active listing on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/active`).then((x) => x.json());
        if (cancelled || !r.active) return;
        const snap = await fetch(`${BACKEND_URL}/api/listing/${r.active.listingId}`).then((x) =>
          x.json()
        );
        if (cancelled) return;
        setListingId(snap.listingId);
        setItemName(snap.itemName);
        setDeadline(snap.deadline);
        setOffers(
          (snap.offers || []).map((o) => ({
            type: "offer_submitted",
            offerIndex: o.index,
            buyer: o.buyer,
            maxBudgetMcop: o.maxBudgetMcop,
            request: o.request,
          }))
        );
        (snap.log || []).forEach(apply);
        if (snap.state === 1) setPhase(PHASES.LIVE);
      } catch (_) {
        /* backend not up — WS will drive it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  // Live WebSocket.
  useEffect(() => {
    let closed = false;
    let retry;
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (msg) => {
        try {
          apply(JSON.parse(msg.data));
        } catch (_) {}
      };
    }
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [apply]);

  return { listingId, itemName, deadline, offers, phase, agent, reveal, connected, PHASES };
}
