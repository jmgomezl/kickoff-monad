import { useEffect, useRef, useState, useCallback } from "react";
import { BACKEND_URL, WS_URL } from "./config";

/**
 * Subscribes to the backend WebSocket and reduces the event stream into a
 * single arena view-model: phase, offers, agent reasoning, winner, reveal.
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
  const [arenaId, setArenaId] = useState(null);
  const [prizeName, setPrizeName] = useState("");
  const [deadline, setDeadline] = useState(null);
  const [offers, setOffers] = useState([]);
  const [phase, setPhase] = useState(PHASES.WAITING);
  const [agent, setAgent] = useState(null); // {reasoning, winnerIndex, winner, amountMon, txHash, explorerUrl}
  const [reveal, setReveal] = useState(null); // {minPriceMon, winningBidMon, spreadMon}
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  const apply = useCallback((e) => {
    switch (e.type) {
      case "arena_created":
        setArenaId(e.arenaId);
        setPrizeName(e.prizeName);
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
        setPhase(PHASES.REASONING);
        setAgent({ reasoning: null, noOffers: true });
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
      case "min_price_revealed":
        setReveal(e);
        setPhase(PHASES.REVEAL);
        break;
      default:
        break;
    }
  }, []);

  // Hydrate the latest active arena on load (so projector can open anytime).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/active`).then((x) => x.json());
        if (cancelled || !r.active) return;
        const snap = await fetch(`${BACKEND_URL}/api/arena/${r.active.arenaId}`).then((x) =>
          x.json()
        );
        if (cancelled) return;
        setArenaId(snap.arenaId);
        setPrizeName(snap.prizeName);
        setDeadline(snap.deadline);
        setOffers(
          (snap.offers || []).map((o) => ({
            type: "offer_submitted",
            offerIndex: o.index,
            bidder: o.bidder,
            amountMon: o.amountMon,
            argument: o.argument,
          }))
        );
        // Replay recorded agent log so a late projector catches reasoning/winner.
        (snap.log || []).forEach(apply);
        if (snap.state === 1) setPhase(PHASES.LIVE);
      } catch (_) {
        /* backend not up yet — WS will drive it */
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

  return { arenaId, prizeName, deadline, offers, phase, agent, reveal, connected, PHASES };
}
