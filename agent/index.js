/**
 * kickoff agent v2 — the negotiator.
 *
 * Watches KickoffMarket. When a listing closes, it reads every buyer's
 * natural-language request, then asks Claude to:
 *   1. pick the WINNER — weighing willingness-to-pay AND the human story/need,
 *   2. NEGOTIATE a fair finalPrice at/below the winner's max (the savings are
 *      what "their agent got them"),
 * then publishes the reasoning and executes executeWinner on-chain.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const fetch = require("node-fetch");
const { startEventPoller } = require("../shared/poller");
const llm = require("../shared/llm");

const {
  MONAD_RPC_URL = "https://testnet-rpc.monad.xyz",
  MARKET_ADDRESS,
  AGENT_PRIVATE_KEY,
  PRIVATE_KEY,
  BACKEND_URL,
  VITE_BACKEND_URL,
} = process.env;

const backendUrl = BACKEND_URL || VITE_BACKEND_URL || "http://localhost:3001";
if (!MARKET_ADDRESS) throw new Error("MARKET_ADDRESS missing");
const key = AGENT_PRIVATE_KEY || PRIVATE_KEY;
if (!key) throw new Error("AGENT_PRIVATE_KEY or PRIVATE_KEY missing");
if (llm.provider() === "none") throw new Error("No LLM key (set ANTHROPIC_API_KEY or OPENAI_API_KEY)");

const ABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "shared", "KickoffMarket.abi.json"), "utf8")
);
const provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
const wallet = new ethers.Wallet(key, provider);
const market = new ethers.Contract(MARKET_ADDRESS, ABI, wallet);

const ONE = 10n ** 18n;
const fmt = (wei) => ethers.formatEther(wei);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const scheduled = new Set();

// Serialize the agent's own txs (multiple listings can close together).
let _aNonce = null;
let _aQueue = Promise.resolve();
async function nextAgentNonce() {
  const c = await provider.getTransactionCount(wallet.address, "pending");
  if (_aNonce === null || c > _aNonce) _aNonce = c;
  return _aNonce++;
}
function agentSend(fn) {
  const run = async () => fn(await nextAgentNonce());
  const p = _aQueue.then(run, run);
  _aQueue = p.catch(() => {});
  return p;
}

async function emitToBackend(event) {
  try {
    await fetch(`${backendUrl}/agent/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (e) {
    console.warn("  (backend unreachable):", e.message);
  }
}

async function evaluate(listingId) {
  if (scheduled.has(`done:${listingId}`)) return;
  scheduled.add(`done:${listingId}`);

  const l = await market.getListing(listingId);
  if (Number(l.state) !== 1) {
    console.log(`Listing ${listingId} not Open; skip.`);
    return;
  }
  if (l.agent.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`Listing ${listingId} agent ${l.agent} != me; skip.`);
    return;
  }
  const offers = await market.getOffers(listingId);
  if (offers.length === 0) {
    console.log(`Listing ${listingId} closed with no offers.`);
    await emitToBackend({ type: "agent_no_offers", listingId: String(listingId) });
    return;
  }

  console.log(`\n🤖 Evaluating listing ${listingId} "${l.itemName}" — ${offers.length} offers`);
  await emitToBackend({
    type: "agent_evaluating",
    listingId: String(listingId),
    itemName: l.itemName,
    offerCount: offers.length,
  });

  const list = offers.map((o, i) => ({
    index: i,
    buyer: short(o.buyer),
    maxBudget: Math.floor(Number(fmt(o.maxBudget))),
    request: o.request,
  }));

  const decision = await askClaude(l.itemName, list);
  const winnerIndex = decision.winnerIndex;
  const winnerMaxWei = offers[winnerIndex].maxBudget;
  let finalWei = BigInt(Math.max(1, Math.round(decision.finalPrice))) * ONE;
  if (finalWei > winnerMaxWei) finalWei = winnerMaxWei; // clamp to max

  const savingsWei = winnerMaxWei - finalWei;
  console.log(`  → winner #${winnerIndex} ${list[winnerIndex].buyer}`);
  console.log(`  → final ${fmt(finalWei)} MONADCOP (saved ${fmt(savingsWei)})`);
  console.log(`  → ${decision.reasoning}`);

  await emitToBackend({
    type: "agent_reasoning",
    listingId: String(listingId),
    winnerIndex,
    winner: offers[winnerIndex].buyer,
    finalPriceMcop: fmt(finalWei),
    maxBudgetMcop: fmt(winnerMaxWei),
    savingsMcop: fmt(savingsWei),
    reasoning: decision.reasoning,
  });

  try {
    const tx = await agentSend((nonce) =>
      market.executeWinner(listingId, winnerIndex, finalWei, decision.reasoning, {
        gasLimit: 600000n,
        nonce,
      })
    );
    console.log(`  ⛓  executeWinner tx: ${tx.hash}`);
    await emitToBackend({ type: "agent_executing", listingId: String(listingId), txHash: tx.hash });
    await tx.wait();
    console.log("  ✅ confirmed");
  } catch (e) {
    console.error("  ❌ executeWinner failed:", e.message);
    await emitToBackend({ type: "agent_error", listingId: String(listingId), message: e.message });
  }
}

async function askClaude(itemName, offers) {
  const prompt = `Eres un agente de IA que actúa como intermediario en un marketplace P2P en vivo sobre Monad (estilo Mercado Libre, pero las decisiones las toma un agente).

Artículo en venta: "${itemName}".

Hay ${offers.length} compradores. Cada uno indicó su presupuesto MÁXIMO (en MONADCOP) y escribió por qué lo quiere. Tu trabajo:
1) Elegir UN ganador. Pondera la disposición a pagar (presupuesto) PERO TAMBIÉN la calidad humana, la sinceridad y la necesidad real del mensaje. Una historia genuina y conmovedora puede ganarle a una oferta más alta pero fría.
2) Negociar un PRECIO FINAL justo para el ganador: un entero en MONADCOP, MENOR O IGUAL a su presupuesto máximo. Consigue un buen precio para el comprador (que ahorre respecto a su máximo) pero coherente con la competencia (no regales el artículo si había ofertas altas).

Compradores:
${offers.map((o) => `#${o.index} — máx ${o.maxBudget} MONADCOP — "${o.request}" (${o.buyer})`).join("\n")}

Responde ÚNICAMENTE con JSON válido, sin texto extra:
{"winnerIndex": <entero>, "finalPrice": <entero MONADCOP ≤ presupuesto del ganador>, "reasoning": "<2-3 frases en español: por qué ganó y por qué ese precio; menciona cuánto ahorró>"}`;

  let parsed = null;
  try {
    const text = await llm.complete(prompt, { maxTokens: 600 });
    parsed = llm.extractJson(text);
  } catch (e) {
    // LLM unreachable/invalid — fall through to the deterministic fallback below
    // so the live demo always produces a winner.
    console.warn("  ⚠️  LLM call failed, using deterministic fallback:", e.message);
  }

  let winnerIndex = Number(parsed?.winnerIndex);
  if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex >= offers.length) {
    // fallback: highest budget
    winnerIndex = offers.reduce((b, o, i) => (o.maxBudget > offers[b].maxBudget ? i : b), 0);
  }
  let finalPrice = Number(parsed?.finalPrice);
  const winnerMax = offers[winnerIndex].maxBudget;
  if (!Number.isFinite(finalPrice) || finalPrice <= 0 || finalPrice > winnerMax) {
    // fallback: second-highest max, or 80% of winner's max
    const others = offers.filter((_, i) => i !== winnerIndex).map((o) => o.maxBudget);
    const second = others.length ? Math.max(...others) : Math.round(winnerMax * 0.8);
    finalPrice = Math.min(winnerMax, Math.max(1, second));
  }
  const reasoning =
    (parsed?.reasoning && String(parsed.reasoning).slice(0, 240)) ||
    `Seleccionado por su historia y disposición a pagar; precio negociado en ${finalPrice} MONADCOP.`;
  return { winnerIndex, finalPrice, reasoning };
}

function schedule(listingId, deadlineSec) {
  const idStr = String(listingId);
  if (scheduled.has(idStr)) return;
  scheduled.add(idStr);
  const waitMs = Math.max(0, (deadlineSec - Math.floor(Date.now() / 1000)) * 1000) + 2000;
  console.log(`⏱  Listing ${idStr} evaluates in ${Math.round(waitMs / 1000)}s`);
  setTimeout(() => evaluate(listingId).catch((e) => console.error(e)), waitMs);
}

async function bootstrap() {
  console.log("─".repeat(60));
  console.log("kickoff agent v2 online");
  console.log("  rpc    :", MONAD_RPC_URL);
  console.log("  market :", MARKET_ADDRESS);
  console.log("  agent  :", wallet.address);
  console.log("  llm    :", llm.provider(), llm.model());
  console.log("─".repeat(60));

  try {
    const count = Number(await market.listingCount());
    for (let id = 1; id <= count; id++) {
      const l = await market.getListing(id);
      if (Number(l.state) === 1) schedule(id, Number(l.deadline));
    }
  } catch (e) {
    console.warn("scan listings failed:", e.message);
  }

  startEventPoller({
    contract: market,
    provider,
    onError: (e) => console.warn("poller:", e.shortMessage || e.message),
    handlers: {
      ListingCreated: (a) => {
        console.log(`\n📣 ListingCreated #${a.listingId} — "${a.itemName}"`);
        schedule(a.listingId, Number(a.deadline));
      },
      OfferSubmitted: (a) => {
        console.log(`   💸 Offer #${a.offerIndex} listing ${a.listingId}: máx ${fmt(a.maxBudget)} — "${a.request}"`);
      },
    },
  });
  console.log("Listening (getLogs poll)…\n");
}

bootstrap().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
