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
  ADMIN_TOKEN,
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
const marketSeller = treasury ? market.connect(treasury) : null;

// Reserve+salt store so the operator can reveal later (survives restarts).
const REVEALS_FILE = path.join(__dirname, "..", "deploy", "reveals.json");
function loadReveals() {
  try {
    return JSON.parse(fs.readFileSync(REVEALS_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}
function saveReveals(r) {
  fs.mkdirSync(path.dirname(REVEALS_FILE), { recursive: true });
  fs.writeFileSync(REVEALS_FILE, JSON.stringify(r, null, 2));
}

// Winner tx hashes (persisted) so history/seller views can deep-link the transfer.
const WINNERS_FILE = path.join(__dirname, "..", "deploy", "winners.json");
function loadWinners() {
  try {
    return JSON.parse(fs.readFileSync(WINNERS_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}
function saveWinners(w) {
  fs.mkdirSync(path.dirname(WINNERS_FILE), { recursive: true });
  fs.writeFileSync(WINNERS_FILE, JSON.stringify(w, null, 2));
}

// Agent reasoning + negotiation dialogue (persisted) so replays survive restarts.
const REASONINGS_FILE = path.join(__dirname, "..", "deploy", "reasonings.json");
function loadReasonings() {
  try {
    return JSON.parse(fs.readFileSync(REASONINGS_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}
function saveReasonings(r) {
  fs.mkdirSync(path.dirname(REASONINGS_FILE), { recursive: true });
  fs.writeFileSync(REASONINGS_FILE, JSON.stringify(r, null, 2));
}

// Seller attitude per listing (humano | equilibrado | agresivo) — read by the agent.
const ATTITUDES_FILE = path.join(__dirname, "..", "deploy", "attitudes.json");
function loadAttitudes() {
  try {
    return JSON.parse(fs.readFileSync(ATTITUDES_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}
function saveAttitudes(a) {
  fs.mkdirSync(path.dirname(ATTITUDES_FILE), { recursive: true });
  fs.writeFileSync(ATTITUDES_FILE, JSON.stringify(a, null, 2));
}
const agentAddress = AGENT_ADDRESS || (treasury ? treasury.address : ethers.ZeroAddress);

const hasLlm = llm.provider() !== "none";
const fmt = (wei) => ethers.formatEther(wei);
const ONE = 10n ** 18n;

// Reject if a promise doesn't settle in time — keeps a flaky RPC call from
// wedging the serialized treasury queue forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout`)), ms)),
  ]);
}

// Read-call with retry — Monad's public RPC intermittently drops view calls.
async function rcall(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw last;
}

// ── Treasury nonce queue (serialize drip + gas-dust txs) ────────────────────
// Re-syncs from the chain's pending count each tx, so it tolerates the seller /
// reveal scripts also spending from this key without nonce collisions.
let _tNonce = null;
let _tQueue = Promise.resolve();
async function nextTreasuryNonce() {
  const chain = await withTimeout(
    provider.getTransactionCount(treasury.address, "pending"),
    8000,
    "nonce-fetch"
  );
  if (_tNonce === null || chain > _tNonce) _tNonce = chain;
  return _tNonce++;
}
function treasuryTx(fn) {
  // Bound both the nonce fetch and the broadcast so one stuck RPC call can never
  // block the queue for the next operation.
  const run = async () => withTimeout(fn(await nextTreasuryNonce()), 25000, "treasury-send");
  const p = _tQueue.then(run, run);
  _tQueue = p.catch(() => {});
  return p;
}

// Monad's parallel execution intermittently reverts a treasury tx when it shares
// a block with another tx touching the same fresh account. A reverted tx still
// consumes its nonce, so retrying picks a fresh nonce and a later block, which
// clears it. Retry on both thrown errors and status-0 receipts.
async function treasurySendRetry(buildFn, label, attempts = 7) {
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
    if (i < attempts - 1) {
      console.warn(`  ${label} attempt ${i + 1} failed, retrying…`);
      // Back off so the retry lands in a later block, clearing the same-block conflict.
      await new Promise((r) => setTimeout(r, 700 + i * 300));
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

// ── Participant tracking (for result DMs) ───────────────────────────────────
const participants = new Map(); // listingId -> [{ userId, address }]
const itemNames = new Map(); // listingId -> itemName
let bot = null; // set up at the bottom; referenced by the winner handler

async function sendResultDMs(listingId, winnerAddr, finalMcop, savingsMcop, explorerUrl) {
  if (!bot) return;
  const parts = participants.get(String(listingId)) || [];
  const item = itemNames.get(String(listingId)) || "el artículo";
  const win = (winnerAddr || "").toLowerCase();
  for (const { userId, address } of parts) {
    if (!String(userId).startsWith("tg-")) continue; // only Telegram users
    const chatId = String(userId).slice(3);
    const won = (address || "").toLowerCase() === win;
    const text = won
      ? `🏆 *¡GANASTE!* — ${item}\n\nTu agente cerró el trato en *${finalMcop} MONADCOP* (te ahorró ${savingsMcop}). ¡El balón es tuyo! ⚽`
      : `Esta vez no ganaste *${item}*. El ganador pagó ${finalMcop} MONADCOP.\n\nTus 50.000 MONADCOP siguen intactos para la próxima 💪`;
    try {
      await bot.telegram.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        ...(won && explorerUrl
          ? { reply_markup: { inline_keyboard: [[{ text: "Ver en el explorador ↗", url: explorerUrl }]] } }
          : {}),
      });
    } catch (e) {
      console.warn(`DM to ${userId} failed:`, e.message);
    }
  }
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
      itemNames.set(String(a.listingId), a.itemName);
      emit({
        type: "listing_created",
        listingId: String(a.listingId),
        seller: a.seller,
        agent: a.agent,
        itemName: a.itemName,
        deadline: Number(a.deadline),
        attitude: loadAttitudes()[String(a.listingId)] || null,
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
      const explorerUrl = log.transactionHash ? `${MONAD_EXPLORER}/tx/${log.transactionHash}` : null;
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
        explorerUrl,
      });
      // Persist the winning tx so history/seller views can deep-link the transfer.
      if (log.transactionHash) {
        const w = loadWinners();
        w[String(a.listingId)] = log.transactionHash;
        saveWinners(w);
      }
      // Notify every participant of their result in Telegram.
      sendResultDMs(a.listingId, a.winner, fmt(a.finalPrice), fmt(a.savings), explorerUrl);
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

// ── Admin (demo control): create a listing / reveal — token-gated ───────────
function adminOk(req) {
  return ADMIN_TOKEN && (req.body?.adminToken === ADMIN_TOKEN || req.get("x-admin-token") === ADMIN_TOKEN);
}

app.post("/api/admin/create-listing", async (req, res) => {
  try {
    if (!adminOk(req)) return res.status(403).json({ error: "unauthorized" });
    if (!marketSeller) return res.status(503).json({ error: "seller not configured" });
    const itemName = String(req.body?.itemName || "Balón oficial Monad Blitz").slice(0, 80);
    const reserveMcop = String(req.body?.reserveMcop ?? "15000");
    const durationSec = Math.max(15, Math.min(3600, Number(req.body?.durationSec || 90)));
    const validAtt = ["humano", "equilibrado", "agresivo"];
    const attitude = validAtt.includes(req.body?.attitude) ? req.body.attitude : "equilibrado";
    const reserve = ethers.parseEther(reserveMcop);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const commit = ethers.solidityPackedKeccak256(["uint256", "bytes32"], [reserve, salt]);
    const block = await provider.getBlock("latest");
    const deadline = block.timestamp + durationSec;

    const tx = await treasuryTx((nonce) =>
      marketSeller.createListing(TOKEN_ADDRESS, commit, deadline, itemName, agentAddress, {
        nonce,
        gasLimit: 400000n,
      })
    );
    let listingId = null;
    try {
      const receipt = await withTimeout(tx.wait(), 25000, "createListing-wait");
      for (const lg of receipt.logs) {
        try {
          const p = market.interface.parseLog(lg);
          if (p?.name === "ListingCreated") listingId = p.args.listingId.toString();
        } catch (_) {}
      }
    } catch (_) {
      /* slow confirm — fall back to the on-chain count below */
    }
    if (listingId == null) {
      await new Promise((r) => setTimeout(r, 1500));
      listingId = (await rcall(() => market.listingCount())).toString();
    }
    activeCache = null; // force a fresh /api/active so clients see it immediately

    const reveals = loadReveals();
    reveals[listingId] = { reserve: reserve.toString(), reserveMcop, salt };
    saveReveals(reveals);
    const atts = loadAttitudes();
    atts[listingId] = attitude;
    saveAttitudes(atts);

    console.log(`admin: created listing ${listingId} "${itemName}" ${durationSec}s [${attitude}] tx ${tx.hash}`);
    res.json({ ok: true, listingId, deadline, durationSec, reserveMcop, attitude, txHash: tx.hash });
  } catch (e) {
    console.error("admin create-listing failed:", e.message);
    res.status(500).json({ error: e.shortMessage || e.message });
  }
});

app.post("/api/admin/reveal", async (req, res) => {
  try {
    if (!adminOk(req)) return res.status(403).json({ error: "unauthorized" });
    if (!marketSeller) return res.status(503).json({ error: "seller not configured" });
    const listingId = String(req.body?.listingId || "");
    const r = loadReveals()[listingId];
    if (!r) return res.status(404).json({ error: "no reveal data for that listing" });
    const tx = await treasuryTx((nonce) =>
      marketSeller.revealReserve(listingId, r.reserve, r.salt, { nonce, gasLimit: 120000n })
    );
    await tx.wait();
    console.log(`admin: revealed listing ${listingId} reserve ${r.reserveMcop} tx ${tx.hash}`);
    res.json({ ok: true, txHash: tx.hash, reserveMcop: r.reserveMcop });
  } catch (e) {
    console.error("admin reveal failed:", e.message);
    res.status(500).json({ error: e.shortMessage || e.message });
  }
});

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
  // Persist the reasoning + dialogue so a replay survives a backend restart.
  if (e.type === "agent_reasoning" && e.listingId) {
    const store = loadReasonings();
    store[String(e.listingId)] = e;
    saveReasonings(store);
  }
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

// Buyer history — reconstructed from on-chain offers/winners (real traceability).
const historyCache = new Map(); // address -> { ts, data }
app.get("/api/history/:userId", async (req, res) => {
  try {
    const addr = wallets.getAddress(req.params.userId);
    if (!addr) return res.json({ address: null, items: [] });

    const cached = historyCache.get(addr.toLowerCase());
    if (cached && Date.now() - cached.ts < 12000) return res.json(cached.data);

    const count = Number(await market.listingCount());
    const from = Math.max(1, count - 25); // last 25 deals
    const winners = loadWinners();
    const items = [];
    for (let id = count; id >= from; id--) {
      try {
        const offers = await rcall(() => market.getOffers(id));
        const idx = offers.findIndex((o) => o.buyer.toLowerCase() === addr.toLowerCase());
        if (idx === -1) continue;
        const l = await rcall(() => market.getListing(id));
        const state = Number(l.state);
        const decided = state >= 2;
        const won = decided && Number(l.winnerIndex) === idx;
        const txHash = winners[String(id)] || null;
        items.push({
          listingId: String(id),
          itemName: l.itemName,
          maxBudgetMcop: fmt(offers[idx].maxBudget),
          request: offers[idx].request,
          state,
          decided,
          won,
          finalPriceMcop: won ? fmt(l.finalPrice) : null,
          reasoning: decided ? l.reasoning || null : null,
          txHash,
          explorerUrl: won && txHash ? `${MONAD_EXPLORER}/tx/${txHash}` : null,
        });
      } catch (_) {
        /* skip a listing that hit a transient RPC error */
      }
    }
    const data = { address: addr, items };
    historyCache.set(addr.toLowerCase(), { ts: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Seller view — all recent deals and what they sold for (on-chain).
let listingsCache = null;
app.get("/api/listings", async (_req, res) => {
  try {
    if (listingsCache && Date.now() - listingsCache.ts < 8000) return res.json(listingsCache.data);
    const count = Number(await market.listingCount());
    const from = Math.max(1, count - 25);
    const winners = loadWinners();
    const out = [];
    for (let id = count; id >= from; id--) {
      try {
        const l = await rcall(() => market.getListing(id));
        const offerCount = Number(await rcall(() => market.getOfferCount(id)));
        const state = Number(l.state);
        const txHash = winners[String(id)] || null;
        out.push({
          listingId: String(id),
          itemName: l.itemName,
          state, // 1 open, 2 decided, 3 revealed, 4 cancelled
          offerCount,
          deadline: Number(l.deadline),
          finalPriceMcop: state >= 2 ? fmt(l.finalPrice) : null,
          revealedReserveMcop: state >= 3 ? fmt(l.revealedReserve) : null,
          marginMcop: state >= 3 ? fmt(l.finalPrice - l.revealedReserve) : null,
          reasoning: state >= 2 ? l.reasoning || null : null,
          txHash,
          explorerUrl: txHash ? `${MONAD_EXPLORER}/tx/${txHash}` : null,
        });
      } catch (_) {
        /* skip a listing that hit a transient RPC error */
      }
    }
    const data = { listings: out, market: MARKET_ADDRESS };
    listingsCache = { ts: Date.now(), data };
    res.json(data);
  } catch (e) {
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

    // Remember who participated so we can DM them their result.
    const lk = String(listingId);
    if (!participants.has(lk)) participants.set(lk, []);
    if (!participants.get(lk).some((p) => p.userId === userId)) {
      participants.get(lk).push({ userId, address: addr });
    }

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
      attitude: loadAttitudes()[String(id)] || null,
      offers: offers.map((o, i) => ({
        index: i,
        buyer: o.buyer,
        maxBudgetMcop: fmt(o.maxBudget),
        request: o.request,
        timestamp: Number(o.timestamp),
      })),
      log: mergedLog(id),
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// In-memory event log + the persisted reasoning (so replays survive restarts).
function mergedLog(id) {
  let log = arenaLog.get(String(id)) || [];
  if (!log.some((x) => x.type === "agent_reasoning")) {
    const stored = loadReasonings()[String(id)];
    if (stored) log = [...log, stored];
  }
  return log;
}

let activeCache = null;
app.get("/api/active", async (_req, res) => {
  try {
    if (activeCache && Date.now() - activeCache.ts < 3000) return res.json(activeCache.data);
    const count = Number(await market.listingCount());
    let active = null;
    let latest = null;
    if (count >= 1) {
      const top = await rcall(() => market.getListing(count));
      latest = {
        listingId: String(count),
        itemName: top.itemName,
        state: Number(top.state),
        deadline: Number(top.deadline),
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (let id = count; id >= Math.max(1, count - 12); id--) {
      const l = await rcall(() => market.getListing(id));
      // Active = open AND still within its window (expired-but-unclosed listings
      // are not a real sale, so the Mini App shows "no active sale").
      if (Number(l.state) === 1 && Number(l.deadline) > nowSec) {
        active = { listingId: String(id), itemName: l.itemName, deadline: Number(l.deadline) };
        break;
      }
    }
    const data = { active, latest, listingCount: count };
    activeCache = { ts: Date.now(), data };
    res.json(data);
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
  bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  // Big, full-width CTA button inside the message (much more visible than the
  // small corner menu button) + a persistent keyboard button above the input.
  const openBtn = Markup.button.webApp("⚽  ABRIR KICKOFF — hacer mi oferta", WEBAPP_URL);
  const welcome = (ctx) =>
    ctx
      .reply(
        "🛒 *KICKOFF* — el marketplace donde tu agente negocia por ti.\n\n" +
          "Recibes *50.000 MONADCOP* gratis. Describe qué quieres comprar y por qué — un agente de IA decidirá el ganador en vivo sobre Monad.\n\n" +
          "👇 Toca el botón grande para abrir la app:",
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[openBtn]]) }
      )
      .catch(() => {});
  bot.start(welcome);
  bot.command("comprar", welcome);
  // Any message (greeting, random text) → show the big button again.
  bot.on("message", welcome);
  bot.launch().then(() => console.log("Telegram bot launched. WebApp:", WEBAPP_URL));
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
} else {
  console.log("⚠️  Telegram bot NOT started (set TELEGRAM_BOT_TOKEN and WEBAPP_URL).");
}
