/**
 * kickoff agent — the AI negotiator.
 *
 * Watches the KickoffArena contract on Monad. When an arena's deadline passes,
 * it pulls every offer, asks Claude to weigh PRICE *and* ARGUMENT quality,
 * publishes its reasoning to the backend (for the big-screen feed), then
 * executes the winning offer on-chain.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const Anthropic = require("@anthropic-ai/sdk");
const fetch = require("node-fetch");

const {
  MONAD_RPC_URL = "https://testnet-rpc.monad.xyz",
  CONTRACT_ADDRESS,
  AGENT_PRIVATE_KEY,
  PRIVATE_KEY,
  ANTHROPIC_API_KEY,
  CLAUDE_MODEL = "claude-sonnet-4-6",
  VITE_BACKEND_URL,
  BACKEND_URL,
} = process.env;

const backendUrl = BACKEND_URL || VITE_BACKEND_URL || "http://localhost:3001";

if (!CONTRACT_ADDRESS) throw new Error("CONTRACT_ADDRESS missing");
const key = AGENT_PRIVATE_KEY || PRIVATE_KEY;
if (!key) throw new Error("AGENT_PRIVATE_KEY or PRIVATE_KEY missing");
if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");

const ABI = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "shared", "KickoffArena.abi.json"), "utf8")
);

const provider = new ethers.JsonRpcProvider(MONAD_RPC_URL);
const wallet = new ethers.Wallet(key, provider);
const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const fmt = (wei) => ethers.formatEther(wei);
const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const scheduled = new Set(); // arenaIds already scheduled/handled

// Push a status event to the backend so the Arena feed can render it live.
async function emitToBackend(event) {
  try {
    await fetch(`${backendUrl}/agent/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  } catch (e) {
    console.warn("  (backend unreachable, continuing):", e.message);
  }
}

async function evaluateArena(arenaId) {
  if (scheduled.has(`done:${arenaId}`)) return;
  scheduled.add(`done:${arenaId}`);

  const a = await contract.getArena(arenaId);
  const state = Number(a.state);
  if (state !== 1) {
    console.log(`Arena ${arenaId} not Open (state ${state}); skipping.`);
    return;
  }

  const offers = await contract.getOffers(arenaId);
  if (offers.length === 0) {
    console.log(`Arena ${arenaId} closed with no offers.`);
    await emitToBackend({ type: "agent_no_offers", arenaId: String(arenaId) });
    return;
  }

  console.log(`\n🤖 Evaluating arena ${arenaId} — ${offers.length} offers`);
  await emitToBackend({
    type: "agent_evaluating",
    arenaId: String(arenaId),
    prizeName: a.prizeName,
    offerCount: offers.length,
  });

  const offerList = offers.map((o, i) => ({
    index: i,
    bidder: shortAddr(o.bidder),
    amountMon: fmt(o.amount),
    argument: o.argument,
  }));

  const { winnerIndex, reasoning } = await askClaude(a.prizeName, offerList);

  console.log(`  → winner #${winnerIndex}: ${offerList[winnerIndex]?.bidder}`);
  console.log(`  → reasoning: ${reasoning}`);

  await emitToBackend({
    type: "agent_reasoning",
    arenaId: String(arenaId),
    winnerIndex,
    winner: offers[winnerIndex].bidder,
    amountMon: fmt(offers[winnerIndex].amount),
    reasoning,
  });

  // Execute on-chain.
  try {
    const tx = await contract.executeWinner(arenaId, winnerIndex, reasoning);
    console.log(`  ⛓  executeWinner tx: ${tx.hash}`);
    await emitToBackend({
      type: "agent_executing",
      arenaId: String(arenaId),
      txHash: tx.hash,
    });
    await tx.wait();
    console.log("  ✅ confirmed");
  } catch (e) {
    console.error("  ❌ executeWinner failed:", e.message);
    await emitToBackend({
      type: "agent_error",
      arenaId: String(arenaId),
      message: e.message,
    });
  }
}

async function askClaude(prizeName, offers) {
  const prompt = `Eres un agente de IA que negocia en una subasta P2P en vivo sobre la blockchain Monad.
El premio es: "${prizeName}".

Hay ${offers.length} ofertas. Cada una tiene un monto (en MON) y un argumento de por qué la persona merece el premio.
Debes elegir UN ganador considerando TANTO el precio COMO la calidad/sinceridad del argumento.
Un argumento excelente puede superar a una oferta más alta, pero el precio importa: no premies algo trivial si otra oferta paga mucho más con buena razón.

Ofertas:
${offers.map((o) => `#${o.index} — ${o.amountMon} MON — "${o.argument}" (de ${o.bidder})`).join("\n")}

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, con esta forma exacta:
{"winnerIndex": <número>, "reasoning": "<2-3 frases en español explicando por qué ganó, mencionando precio y argumento>"}`;

  const resp = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const text = resp.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const parsed = extractJson(text);

  let winnerIndex = Number(parsed?.winnerIndex);
  if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex >= offers.length) {
    // Fallback: highest bid.
    winnerIndex = offers.reduce(
      (best, o, i) => (parseFloat(o.amountMon) > parseFloat(offers[best].amountMon) ? i : best),
      0
    );
  }
  const reasoning =
    (parsed?.reasoning && String(parsed.reasoning).slice(0, 600)) ||
    "El agente seleccionó esta oferta por su balance entre precio y argumento.";

  return { winnerIndex, reasoning };
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch (_) {}
  }
  return null;
}

function scheduleArena(arenaId, deadlineSec) {
  const idStr = String(arenaId);
  if (scheduled.has(idStr)) return;
  scheduled.add(idStr);

  const nowSec = Math.floor(Date.now() / 1000);
  const waitMs = Math.max(0, (deadlineSec - nowSec) * 1000) + 2000; // +2s buffer
  console.log(`⏱  Arena ${idStr} scheduled to evaluate in ${Math.round(waitMs / 1000)}s`);
  setTimeout(() => evaluateArena(arenaId).catch((e) => console.error(e)), waitMs);
}

async function bootstrap() {
  console.log("─".repeat(60));
  console.log("kickoff agent online");
  console.log("  rpc     :", MONAD_RPC_URL);
  console.log("  contract:", CONTRACT_ADDRESS);
  console.log("  agent   :", wallet.address);
  console.log("  model   :", CLAUDE_MODEL);
  console.log("  backend :", backendUrl);
  console.log("─".repeat(60));

  // Pick up any already-open arenas (e.g. created before the agent started).
  try {
    const count = Number(await contract.arenaCount());
    for (let id = 1; id <= count; id++) {
      const a = await contract.getArena(id);
      if (Number(a.state) === 1) scheduleArena(id, Number(a.deadline));
    }
  } catch (e) {
    console.warn("Could not scan existing arenas:", e.message);
  }

  contract.on("ArenaCreated", (arenaId, seller, agent, prizeName, deadline) => {
    console.log(`\n📣 ArenaCreated #${arenaId} — "${prizeName}"`);
    scheduleArena(arenaId, Number(deadline));
  });

  contract.on("OfferSubmitted", (arenaId, offerIndex, bidder, amount, argument) => {
    console.log(`   💸 Offer #${offerIndex} on arena ${arenaId}: ${fmt(amount)} MON — "${argument}"`);
  });

  console.log("Listening for events…\n");
}

bootstrap().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
