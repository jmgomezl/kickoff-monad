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
  const [txs, setTxs] = useState([]);
  const [replaying, setReplaying] = useState(false);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);
  const replayTimers = useRef([]);

  const clearReplay = useCallback(() => {
    replayTimers.current.forEach(clearTimeout);
    replayTimers.current = [];
    setReplaying(false);
  }, []);

  const addTx = useCallback((kind, txHash, amount) => {
    if (!txHash) return;
    setTxs((prev) => (prev.some((t) => t.txHash === txHash) ? prev : [...prev, { kind, txHash, amount }]));
  }, []);

  const apply = useCallback((e) => {
    switch (e.type) {
      case "listing_created":
        clearReplay();
        setListingId(e.listingId);
        setItemName(e.itemName);
        setDeadline(e.deadline);
        setOffers([]);
        setAgent(null);
        setReveal(null);
        setTxs([]);
        addTx("listing", e.txHash);
        setPhase(PHASES.LIVE);
        break;
      case "offer_submitted":
        setOffers((prev) => {
          if (prev.some((o) => o.txHash && o.txHash === e.txHash)) return prev;
          return [...prev, e];
        });
        addTx("offer", e.txHash, e.maxBudgetMcop);
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
        addTx("exec", e.txHash);
        break;
      case "winner_chosen":
        setAgent((a) => ({ ...(a || {}), ...e, executing: false }));
        addTx("pay", e.txHash, e.finalPriceMcop);
        setPhase(PHASES.WINNER);
        break;
      case "reserve_revealed":
        setReveal(e);
        addTx("reveal", e.txHash);
        setPhase(PHASES.REVEAL);
        break;
      default:
        break;
    }
  }, []);

  // Hydrate on load: if there's an open deal → go live; if the latest deal is
  // already decided → REPLAY the whole sealed→negotiation→winner→reveal sequence
  // so the drama plays even when the projector loads late.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${BACKEND_URL}/api/active`).then((x) => x.json());
        const targetId = r.active?.listingId || r.latest?.listingId;
        if (cancelled || !targetId) return;
        const snap = await fetch(`${BACKEND_URL}/api/listing/${targetId}`).then((x) => x.json());
        if (cancelled || !snap?.listingId) return;

        setListingId(snap.listingId);
        setItemName(snap.itemName);
        setDeadline(snap.deadline);
        const offerVMs = (snap.offers || []).map((o) => ({
          type: "offer_submitted",
          offerIndex: o.index,
          buyer: o.buyer,
          maxBudgetMcop: o.maxBudgetMcop,
          request: o.request,
        }));
        setOffers(offerVMs);
        // Replay the on-chain txs into the ticker either way.
        (snap.log || []).filter((e) => e.txHash).forEach((e) => apply(e));

        if (snap.state === 1) {
          setPhase(PHASES.LIVE); // open — WS drives the rest live
        } else if (snap.state >= 2) {
          replaySnap(snap, offerVMs);
        }
      } catch (_) {
        /* backend not up — WS will drive it */
      }
    })();
    return () => {
      cancelled = true;
      clearReplay();
    };
  }, [apply, clearReplay]);

  // Scripted re-play of a finished deal.
  function replaySnap(snap, offerVMs) {
    clearReplay();
    setReplaying(true);
    setReveal(null);
    setAgent(null);

    const log = snap.log || [];
    const reasoningEv = log.find((e) => e.type === "agent_reasoning");
    const winnerEv = log.find((e) => e.type === "winner_chosen");
    const revealEv = log.find((e) => e.type === "reserve_revealed");

    const wi = Number(snap.winnerIndex) || 0;
    const wOff = offerVMs[wi] || {};
    const finalP = Number(snap.finalPriceMcop || 0);
    const maxB = Number(wOff.maxBudgetMcop || 0);
    const dialogue = reasoningEv?.dialogue || [];
    const agentData = {
      winnerIndex: wi,
      winner: winnerEv?.winner || wOff.buyer,
      finalPriceMcop: snap.finalPriceMcop,
      maxBudgetMcop: wOff.maxBudgetMcop,
      savingsMcop: String(Math.max(0, maxB - finalP)),
      reasoning: reasoningEv?.reasoning || snap.reasoning,
      dialogue,
      txHash: winnerEv?.txHash,
      explorerUrl: winnerEv?.explorerUrl,
    };

    const T = [];
    const at = (ms, fn) => T.push(setTimeout(fn, ms));
    setPhase(PHASES.LIVE); // sealed bidding
    at(2600, () => setPhase(PHASES.EVALUATING)); // offers unseal, deliberating
    at(5200, () => {
      setAgent(agentData);
      setPhase(PHASES.REASONING); // negotiation plays out
    });
    const dlgMs = (dialogue.length || 0) * 2200 + 1800;
    const tWinner = 5200 + dlgMs;
    at(tWinner, () => {
      setAgent((a) => ({ ...(a || {}), ...agentData }));
      setPhase(PHASES.WINNER);
    });
    if (snap.state >= 3 || revealEv) {
      const revealData = revealEv || {
        reserveMcop: snap.revealedReserveMcop,
        finalPriceMcop: snap.finalPriceMcop,
        marginMcop: String(finalP - Number(snap.revealedReserveMcop || 0)),
      };
      at(tWinner + 6000, () => {
        setReveal(revealData);
        setPhase(PHASES.REVEAL);
      });
    }
    replayTimers.current = T;
  }

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

  return { listingId, itemName, deadline, offers, phase, agent, reveal, txs, replaying, connected, PHASES };
}
