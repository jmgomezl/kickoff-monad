/**
 * kickoff backend v2 — agent-driven marketplace.
 *
 *  • Per-Telegram-user CUSTODIAL wallets (KMS-encrypted, see wallets.js).
 *  • On join: drip 50,000 MONADCOP + a little MON for gas.
 *  • Offer: user types a natural-language request ("quiero X, doy hasta 50mil,
 *    porque…"); Claude extracts their MAX budget; backend signs approve +
 *    submitOffer from the user's wallet.
 *  • Streams KickoffMarket events over WebSocket to the big-screen feed.
 *  • Telegram bot opens the Mini App.
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
const { startEventPoller } = require("../shared/poller");
const llm = require("../shared/llm");
const wallets = require("./wallets");

const {
  MONAD_RPC_URL = "https://testnet-rpc.monad.xyz",
  MONAD_EXPLORER = "https://testnet.monadexplorer.com",
  MARKET_ADDRESS,
  TOKEN_ADDRESS,
  TREASURY_PRIVATE_KEY,
  PRIVATE_KEY,
  AGENT_ADDRESS,
  GAS_DUST_MON = "0.05",
  PORT = "3001",
  WS_PORT = "3002",
  TELEGRAM_BOT_TOKEN,
  WEBAPP_URL,
} = process.env;

if (!MARKET_ADDRESS) throw new Error("MARKET_ADDRESS missing");
if (!TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS missing");

const MARKET_ABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "shared", "KickoffMarket.abi.json"), "utf8")
);
const TOKEN_ABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "shared", "MONADCOP.abi.json"), "utf8")
);

const provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
const market = new ethers.Contract(MARKET_ADDRESS, MARKET_ABI, provider);
const token = new ethers.Contract(TOKEN_ADDRESS, TOKEN_ABI, provider);

// Treasury = MONADCOP owner (must be the deployer to call drip). Pays gas dust.
const treasuryKey = TREASURY_PRIVATE_KEY || PRIVATE_KEY;
const treasury = treasuryKey ? new ethers.Wallet(treasuryKey, provider) : null;
const treasuryToken = treasury ? token.connect(treasury) : null;
const agentAddress = AGENT_ADDRESS || (treasury ? treasury.address : ethers.ZeroAddress);

const hasLlm = llm.provider() !== "none";
const fmt = (wei) => ethers.formatEther(wei);
const ONE = 10n ** 18n;

// ── Treasury nonce queue (serialize drip + gas-dust txs) ────────────────────
// Re-syncs from the chain's pending count each tx, so it tolerates the seller /
// reveal scripts also spending from this key without nonce collisions.
let _tNonce = null;
let _tQueue = Promise.resolve();
async function nextTreasuryNonce() {
  const chain = await provider.getTransactionCount(treasury.address, "pending");
  if (_tNonce === null || chain > _tNonce) _tNonce = chain;
  return _tNonce++;
}
function treasuryTx(fn) {
  const run = async () => fn(await nextTreasuryNonce());
  const p = _tQueue.then(run, run);
  _tQueue = p.catch(() => {});
  return p;
}

// Monad's parallel execution intermittently reverts a treasury tx when it shares
// a block with another tx touching the same fresh account. A reverted tx still
// consumes its nonce, so retrying picks a fresh nonce and a later block, which
// clears it. Retry on both thrown errors and status-0 receipts.
async function treasurySendRetry(buildFn, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const tx = await treasuryTx((nonce) => buildFn(nonce));
      const r = await tx.wait();
      if (r?.status === 1) return r;
      lastErr = new Error(`${label} reverted`);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) console.warn(`  ${label} attempt ${i + 1} failed, retrying…`);
  }
  throw lastErr || new Error(`${label} failed`);
}

// ── WebSocket fan-out ───────────────────────────────────────────────────────
const arenaLog = new Map();
function record(id, e) {
  const k = String(id);
  if (!arenaLog.has(k)) arenaLog.set(k, []);
  arenaLog.get(k).push(e);
}
const wss = new WebSocketServer({ port: Number(WS_PORT) });
function broadcast(e) {
  const s = JSON.stringify(e);
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
}
wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello", ts: new Date().toISOString() })));
function emit(e) {
  const ev = { ...e, ts: new Date().toISOString() };
  if (ev.listingId) record(ev.listingId, ev);
  broadcast(ev);
}
console.log("WebSocket on ws://localhost:" + WS_PORT);

// ── Market event poller (Monad has no eth_newFilter) ────────────────────────
startEventPoller({
  contract: market,
  provider,
  onError: (e) => console.warn("poller:", e.shortMessage || e.message),
  handlers: {
    ListingCreated: (a, log) => {
      console.log(`ListingCreated #${a.listingId} "${a.itemName}"`);
      emit({
        type: "listing_created",
        listingId: String(a.listingId),
        seller: a.seller,
        agent: a.agent,
        itemName: a.itemName,
        deadline: Number(a.deadline),
        txHash: log.transactionHash,
      });
    },
    OfferSubmitted: (a, log) => {
      console.log(`OfferSubmitted listing ${a.listingId} #${a.offerIndex} max=${fmt(a.maxBudget)}`);
      emit({
        type: "offer_submitted",
        listingId: String(a.listingId),
        offerIndex: Number(a.offerIndex),
        buyer: a.buyer,
        maxBudgetMcop: fmt(a.maxBudget),
        request: a.request,
        txHash: log.transactionHash,
      });
    },
    WinnerChosen: (a, log) => {
      console.log(`WinnerChosen listing ${a.listingId} -> #${a.winnerIndex} price=${fmt(a.finalPrice)}`);
      emit({
        type: "winner_chosen",
        listingId: String(a.listingId),
        winnerIndex: Number(a.winnerIndex),
        winner: a.winner,
        finalPriceMcop: fmt(a.finalPrice),
        maxBudgetMcop: fmt(a.maxBudget),
        savingsMcop: fmt(a.savings),
        reasoning: a.reasoning,
        txHash: log.transactionHash,
        explorerUrl: log.transactionHash ? `${MONAD_EXPLORER}/tx/${log.transactionHash}` : null,
      });
    },
    ReserveRevealed: (a, log) => {
      console.log(`ReserveRevealed listing ${a.listingId} reserve=${fmt(a.reserve)}`);
      emit({
        type: "reserve_revealed",
        listingId: String(a.listingId),
        reserveMcop: fmt(a.reserve),
        finalPriceMcop: fmt(a.finalPrice),
        marginMcop: fmt(a.margin),
        txHash: log.transactionHash,
      });
    },
  },
});

// ── Claude: extract a max budget from free-text ─────────────────────────────
async function parseMaxBudget(text, balanceMcop) {
  const cap = Math.floor(Number(balanceMcop));
  // Heuristic fallback first (works offline): "50mil", "50.000", "50000".
  const regexGuess = (() => {
    const t = text.toLowerCase();
    if (/todo (mi )?dinero|todo lo que tengo/.test(t)) return cap;
    const mil = t.match(/(\d+(?:[.,]\d+)?)\s*mil/);
    if (mil) return Math.round(parseFloat(mil[1].replace(",", ".")) * 1000);
    const num = t.match(/(\d[\d.,]{2,})/);
    if (num) return Math.round(parseFloat(num[1].replace(/\./g, "").replace(",", ".")));
    return cap;
  })();

  if (!hasLlm) return Math.min(Math.max(1, regexGuess), cap);

  try {
    const out = await llm.complete(
      `El usuario tiene ${cap} MONADCOP. De este mensaje, ¿cuál es el MÁXIMO que está dispuesto a pagar, en MONADCOP (número entero, sin exceder ${cap})? Si dice "todo mi dinero" usa ${cap}. Responde SOLO con JSON: {"maxBudget": <entero>}.\n\nMensaje: "${text.replace(/"/g, "'")}"`,
      { maxTokens: 60 }
    );
    const parsed = llm.extractJson(out);
    if (parsed) {
      const v = Math.round(Number(parsed.maxBudget));
      if (Number.isFinite(v) && v > 0) return Math.min(v, cap);
    }
  } catch (e) {
    console.warn("parseMaxBudget llm failed:", e.message);
  }
  return Math.min(Math.max(1, regexGuess), cap);
}

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, market: MARKET_ADDRESS, token: TOKEN_ADDRESS }));

app.get("/api/config", async (_req, res) => {
  res.json({
    market: MARKET_ADDRESS,
    token: TOKEN_ADDRESS,
    explorer: MONAD_EXPLORER,
    agent: agentAddress,
    walletMode: await wallets.mode().catch(() => "unknown"),
  });
});

app.post("/agent/event", (req, res) => {
  const e = req.body || {};
  if (!e.type) return res.status(400).json({ error: "missing type" });
  emit(e);
  res.json({ ok: true });
});

// Join: create the user's wallet, drip MONADCOP + gas dust if new.
app.post("/api/join", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "userId required" });
    if (!treasuryToken) return res.status(503).json({ error: "treasury not configured" });

    const { address, isNew } = await wallets.getOrCreateWallet(userId);

    // Self-healing funding: ensure the wallet is dripped (once) and has gas,
    // even on retries after a partial/failed earlier funding.
    const [claimed, mon] = await Promise.all([
      token.hasClaimed(address),
      provider.getBalance(address),
    ]);
    const minGas = ethers.parseEther(String(GAS_DUST_MON)) / 2n;
    const did = [];

    // IMPORTANT: drip (mint) and dust (value) to the SAME new account in the same
    // block revert under Monad's parallel execution. Do them sequentially — wait
    // for the drip to mine before sending the dust.
    if (!claimed) {
      await treasurySendRetry(
        (nonce) => treasuryToken.drip(address, { nonce, gasLimit: 120000n }),
        "drip"
      );
      did.push("drip");
    }
    if (mon < minGas) {
      await treasurySendRetry(
        (nonce) =>
          treasury.sendTransaction({
            to: address,
            value: ethers.parseEther(String(GAS_DUST_MON)),
            nonce,
            gasLimit: 60000n,
          }),
        "dust"
      );
      did.push("dust");
    }
    if (did.length) console.log(`join: ${address} for ${userId} funded (${did.join("+")})`);

    const bal = await token.balanceOf(address);
    res.json({ address, isNew, balanceMcop: fmt(bal) });
  } catch (e) {
    console.error("join failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/wallet/:userId", async (req, res) => {
  try {
    const addr = wallets.getAddress(req.params.userId);
    if (!addr) return res.json({ address: null });
    const [bal, mon] = await Promise.all([token.balanceOf(addr), provider.getBalance(addr)]);
    res.json({ address: addr, balanceMcop: fmt(bal), monBalance: fmt(mon) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Offer: parse budget, approve + submitOffer from the user's custodial wallet.
app.post("/api/offer", async (req, res) => {
  try {
    const userId = String(req.body?.userId || "").trim();
    const listingId = String(req.body?.listingId || "").trim();
    const text = String(req.body?.text || "").trim();
    if (!userId || !listingId || !text) {
      return res.status(400).json({ error: "userId, listingId, text required" });
    }
    if (text.length > 500) return res.status(400).json({ error: "message too long (max 500)" });

    const addr = wallets.getAddress(userId);
    if (!addr) return res.status(400).json({ error: "join first" });

    const bal = await token.balanceOf(addr);
    const balMcop = fmt(bal);
    const maxBudgetInt = await parseMaxBudget(text, balMcop);
    const maxBudgetWei = BigInt(maxBudgetInt) * ONE;
    if (maxBudgetWei > bal) {
      return res.status(400).json({ error: "budget exceeds balance" });
    }

    const signer = await wallets.getSigner(userId, provider);
    const uToken = token.connect(signer);
    const uMarket = market.connect(signer);

    // approve then submitOffer (sequential; user wallet has its own nonce).
    const apTx = await uToken.approve(MARKET_ADDRESS, maxBudgetWei, { gasLimit: 80000n });
    await apTx.wait();
    const offTx = await uMarket.submitOffer(listingId, maxBudgetWei, text, { gasLimit: 700000n });

    console.log(`offer: ${addr} listing ${listingId} max=${maxBudgetInt} tx=${offTx.hash}`);
    res.json({ ok: true, txHash: offTx.hash, maxBudget: maxBudgetInt });
    // OfferSubmitted event will broadcast on confirm.
  } catch (e) {
    console.error("offer failed:", e.message);
    res.status(500).json({ error: e.shortMessage || e.message });
  }
});

// Snapshot of a listing (state + offers + recorded log).
app.get("/api/listing/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const l = await market.getListing(id);
    const offers = await market.getOffers(id);
    res.json({
      listingId: id,
      seller: l.seller,
      agent: l.agent,
      itemName: l.itemName,
      deadline: Number(l.deadline),
      state: Number(l.state),
      winnerIndex: Number(l.winnerIndex),
      finalPriceMcop: fmt(l.finalPrice),
      revealedReserveMcop: fmt(l.revealedReserve),
      reasoning: l.reasoning,
      offers: offers.map((o, i) => ({
        index: i,
        buyer: o.buyer,
        maxBudgetMcop: fmt(o.maxBudget),
        request: o.request,
        timestamp: Number(o.timestamp),
      })),
      log: arenaLog.get(String(id)) || [],
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get("/api/active", async (_req, res) => {
  try {
    const count = Number(await market.listingCount());
    let active = null;
    for (let id = count; id >= 1; id--) {
      const l = await market.getListing(id);
      if (Number(l.state) === 1) {
        active = { listingId: String(id), itemName: l.itemName, deadline: Number(l.deadline) };
        break;
      }
    }
    res.json({ active, listingCount: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);
server.listen(Number(PORT), async () => {
  const mode = await wallets.mode().catch(() => "?");
  console.log("─".repeat(60));
  console.log("kickoff backend v2");
  console.log("  http     : http://localhost:" + PORT);
  console.log("  market   :", MARKET_ADDRESS);
  console.log("  token    :", TOKEN_ADDRESS);
  console.log("  treasury :", treasury ? treasury.address : "(none)");
  console.log("  agent    :", agentAddress);
  console.log("  wallets  :", mode);
  console.log("  llm      :", hasLlm ? `${llm.provider()} ${llm.model()}` : "(disabled — regex budget parse)");
  console.log("─".repeat(60));
});

// ── Telegram bot ────────────────────────────────────────────────────────────
if (TELEGRAM_BOT_TOKEN && WEBAPP_URL) {
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  const welcome = (ctx) =>
    ctx.reply(
      "🛒 *KICKOFF* — el marketplace donde tu agente negocia por ti.\n\n" +
        "Recibes *50.000 MONADCOP* gratis. Describe qué quieres comprar y por qué — un agente de IA decidirá el ganador en vivo sobre Monad.",
      {
        parse_mode: "Markdown",
        ...Markup.keyboard([[Markup.button.webApp("🛒 Abrir kickoff", WEBAPP_URL)]]).resize(),
      }
    );
  bot.start(welcome);
  bot.command("comprar", welcome);
  bot.hears(/hola|hi|hello|start|comprar/i, welcome);
  bot.launch().then(() => console.log("Telegram bot launched. WebApp:", WEBAPP_URL));
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
} else {
  console.log("⚠️  Telegram bot NOT started (set TELEGRAM_BOT_TOKEN and WEBAPP_URL).");
}
