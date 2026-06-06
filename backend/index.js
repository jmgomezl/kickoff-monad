/**
 * kickoff backend — real-time relay + Telegram bot.
 *
 *  • Listens to KickoffArena events on Monad and broadcasts them over WebSocket
 *    to the Arena feed (big screen) and Offer Mini App.
 *  • Exposes REST snapshots so late-joining clients can catch up.
 *  • Receives the agent's live reasoning via POST /agent/event and rebroadcasts.
 *  • Runs a Telegram bot whose button opens the Offer Mini App.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");
const { ethers } = require("ethers");
const { Telegraf, Markup } = require("telegraf");

const {
  MONAD_RPC_URL = "https://rpc.monad.xyz",
  MONAD_EXPLORER = "https://monadscan.com",
  CONTRACT_ADDRESS,
  PORT = "3001",
  WS_PORT = "3002",
  TELEGRAM_BOT_TOKEN,
  WEBAPP_URL,
  RELAYER_PRIVATE_KEY,
  PRIVATE_KEY,
  MAX_OFFER_MON = "0.05",
} = process.env;

if (!CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS missing");

const ABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "shared", "KickoffArena.abi.json"), "utf8")
);

const provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
const fmt = (wei) => ethers.formatEther(wei);

// Relayer: submits offers on behalf of the crowd (who have no wallet/MON).
// Each Mini App submission becomes a payable submitOffer tx from this wallet,
// with the bidder's display name embedded in the argument.
const relayerKey = RELAYER_PRIVATE_KEY || PRIVATE_KEY;
const relayer = relayerKey ? new ethers.Wallet(relayerKey, provider) : null;
const relayerContract = relayer ? contract.connect(relayer) : null;
const maxOfferWei = ethers.parseEther(String(MAX_OFFER_MON));

// Serialize relayed txs with a managed nonce so simultaneous scans don't clash.
let _nonce = null;
let _queue = Promise.resolve();
async function relayOffer(arenaId, argument, valueWei) {
  if (!relayerContract) throw new Error("relayer not configured");
  const run = async () => {
    if (_nonce === null) _nonce = await provider.getTransactionCount(relayer.address, "pending");
    const nonce = _nonce++;
    const tx = await relayerContract.submitOffer(arenaId, argument, {
      value: valueWei,
      nonce,
    });
    return tx;
  };
  // Chain onto the queue; isolate failures so one bad tx doesn't wedge the line.
  const p = _queue.then(run, run);
  _queue = p.catch(() => {});
  return p;
}

// ── In-memory event log per arena (so new clients can catch up) ────────────
const arenaLog = new Map(); // arenaId -> [events]
function record(arenaId, event) {
  const id = String(arenaId);
  if (!arenaLog.has(id)) arenaLog.set(id, []);
  arenaLog.get(id).push(event);
}

// ── WebSocket fan-out ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: Number(WS_PORT) });
function broadcast(event) {
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}
wss.on("connection", (ws) => {
  console.log("ws client connected; total:", wss.clients.size);
  ws.send(JSON.stringify({ type: "hello", ts: nowIso() }));
});
console.log("WebSocket listening on ws://localhost:" + WS_PORT);

function emit(event) {
  const e = { ...event, ts: nowIso() };
  if (e.arenaId) record(e.arenaId, e);
  broadcast(e);
}
function nowIso() {
  return new Date().toISOString();
}

// ── Contract event listeners ───────────────────────────────────────────────
contract.on("ArenaCreated", (arenaId, seller, agent, prizeName, deadline, collateral, ev) => {
  console.log(`ArenaCreated #${arenaId} "${prizeName}"`);
  emit({
    type: "arena_created",
    arenaId: String(arenaId),
    seller,
    agent,
    prizeName,
    deadline: Number(deadline),
    collateralMon: fmt(collateral),
    txHash: ev?.log?.transactionHash,
  });
});

contract.on("OfferSubmitted", (arenaId, offerIndex, bidder, amount, argument, ev) => {
  console.log(`OfferSubmitted arena ${arenaId} #${offerIndex} ${fmt(amount)} MON`);
  emit({
    type: "offer_submitted",
    arenaId: String(arenaId),
    offerIndex: Number(offerIndex),
    bidder,
    amountMon: fmt(amount),
    argument,
    txHash: ev?.log?.transactionHash,
  });
});

contract.on("WinnerChosen", (arenaId, winnerIndex, winner, amount, reasoning, ev) => {
  console.log(`WinnerChosen arena ${arenaId} -> #${winnerIndex} ${winner}`);
  emit({
    type: "winner_chosen",
    arenaId: String(arenaId),
    winnerIndex: Number(winnerIndex),
    winner,
    amountMon: fmt(amount),
    reasoning,
    txHash: ev?.log?.transactionHash,
    explorerUrl: ev?.log?.transactionHash ? `${MONAD_EXPLORER}/tx/${ev.log.transactionHash}` : null,
  });
});

contract.on("MinPriceRevealed", (arenaId, minPrice, winningBid, spread, ev) => {
  console.log(`MinPriceRevealed arena ${arenaId} min=${fmt(minPrice)}`);
  emit({
    type: "min_price_revealed",
    arenaId: String(arenaId),
    minPriceMon: fmt(minPrice),
    winningBidMon: fmt(winningBid),
    spreadMon: fmt(spread),
    txHash: ev?.log?.transactionHash,
  });
});

// ── Express REST + agent ingress ───────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, contract: CONTRACT_ADDRESS }));

// The agent posts its live reasoning here; we rebroadcast to all WS clients.
app.post("/agent/event", (req, res) => {
  const event = req.body || {};
  if (!event.type) return res.status(400).json({ error: "missing type" });
  emit(event);
  res.json({ ok: true });
});

// Snapshot of an arena (state + offers + recorded event log) for catch-up.
app.get("/api/arena/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const a = await contract.getArena(id);
    const offers = await contract.getOffers(id);
    res.json({
      arenaId: id,
      seller: a.seller,
      agent: a.agent,
      prizeName: a.prizeName,
      deadline: Number(a.deadline),
      state: Number(a.state),
      winnerIndex: Number(a.winnerIndex),
      revealedMinPriceMon: fmt(a.revealedMinPrice),
      reasoning: a.reasoning,
      collateralMon: fmt(a.collateral),
      offers: offers.map((o, i) => ({
        index: i,
        bidder: o.bidder,
        amountMon: fmt(o.amount),
        argument: o.argument,
        timestamp: Number(o.timestamp),
      })),
      log: arenaLog.get(String(id)) || [],
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Latest open arena id (handy for the Mini App + feed).
app.get("/api/active", async (_req, res) => {
  try {
    const count = Number(await contract.arenaCount());
    let active = null;
    for (let id = count; id >= 1; id--) {
      const a = await contract.getArena(id);
      if (Number(a.state) === 1) {
        active = { arenaId: String(id), prizeName: a.prizeName, deadline: Number(a.deadline) };
        break;
      }
    }
    res.json({ active, arenaCount: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crowd offer ingress — relayed on-chain by the house wallet.
app.post("/api/offer", async (req, res) => {
  try {
    if (!relayerContract) return res.status(503).json({ error: "relayer not configured" });
    const { arenaId, name, amountMon, argument } = req.body || {};
    if (!arenaId) return res.status(400).json({ error: "arenaId required" });

    const amt = Number(amountMon);
    if (!(amt > 0)) return res.status(400).json({ error: "amount must be > 0" });
    const valueWei = ethers.parseEther(String(amountMon));
    if (valueWei > maxOfferWei) {
      return res.status(400).json({ error: `max offer is ${MAX_OFFER_MON} MON` });
    }

    const cleanName = String(name || "Anónimo").replace(/[\r\n]/g, " ").slice(0, 40).trim();
    const cleanArg = String(argument || "").replace(/[\r\n]/g, " ").slice(0, 800).trim();
    if (!cleanArg) return res.status(400).json({ error: "argument required" });

    // Embed the display name so the feed/agent can attribute the offer.
    const composed = `${cleanName} — ${cleanArg}`;

    const tx = await relayOffer(arenaId, composed, valueWei);
    console.log(`relayed offer arena ${arenaId} "${cleanName}" ${amountMon} MON tx ${tx.hash}`);
    res.json({ ok: true, txHash: tx.hash });
    // We don't await tx.wait(); the OfferSubmitted event will broadcast on confirm.
  } catch (e) {
    console.error("relay offer failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/config", (_req, res) => {
  res.json({
    contractAddress: CONTRACT_ADDRESS,
    rpcUrl: MONAD_RPC_URL,
    explorer: MONAD_EXPLORER,
  });
});

const server = http.createServer(app);
server.listen(Number(PORT), () => {
  console.log("─".repeat(60));
  console.log("kickoff backend");
  console.log("  http    : http://localhost:" + PORT);
  console.log("  ws      : ws://localhost:" + WS_PORT);
  console.log("  contract:", CONTRACT_ADDRESS);
  console.log("  rpc     :", MONAD_RPC_URL);
  console.log("─".repeat(60));
});

// ── Telegram bot ───────────────────────────────────────────────────────────
if (TELEGRAM_BOT_TOKEN && WEBAPP_URL) {
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  const welcome = (ctx) =>
    ctx.reply(
      "⚽ *KICKOFF* — Tu agente negocia, tú ganas.\n\n" +
        "Toca el botón para hacer tu oferta por el premio. Un agente de IA decidirá el ganador en vivo sobre Monad.",
      {
        parse_mode: "Markdown",
        ...Markup.keyboard([
          [Markup.button.webApp("⚽ Hacer una oferta / Make an offer", WEBAPP_URL)],
        ]).resize(),
      }
    );

  bot.start(welcome);
  bot.command("offer", welcome);
  bot.command("oferta", welcome);
  bot.hears(/hola|hi|hello|start/i, welcome);

  bot.launch().then(() => console.log("Telegram bot launched. WebApp:", WEBAPP_URL));
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
} else {
  console.log("⚠️  Telegram bot NOT started (set TELEGRAM_BOT_TOKEN and WEBAPP_URL).");
}
