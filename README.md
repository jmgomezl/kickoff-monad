# ⚽ kickoff.bot

**Your agent negotiates. You win.** · _Tu agente negocia. Tú ganas._

An **agent-driven marketplace** on **Monad** — think Mercado Libre / eBay, but an
**AI agent makes the call**. Buyers open a Telegram Mini App, get **50,000
MONADCOP** for free, and describe — ChatGPT-style — what they want, their budget,
and *why*. The agent reads every request, weighs **price _and_ the human story**,
picks a winner, and **negotiates the final price** (above the seller's hidden
reserve, at or below the buyer's max). The winner pays only the negotiated price;
the difference is what *their agent saved them*. 0.4s finality, near-zero gas.

> Built for **Monad Blitz Medellín** — June 2026.
> On stage: a real football, a QR code, 90 seconds of live offers, an AI agent
> deciding in front of the crowd, and a dramatic reserve reveal.

---

## How it works

```
 Seller ──commit keccak256(reserve, salt)──▶ KickoffMarket.sol  (Monad)
 Buyer  ──"quiero X, doy hasta 50mil, porque…"──▶ approve + submitOffer (MONADCOP)
 Agent  ──reads every request, scores price + story──▶ executeWinner(idx, finalPrice)
 Seller ──revealReserve(reserve, salt)──▶ THE REVEAL (margin over reserve)
```

- **Custodial wallets**: each Telegram user gets a wallet created server-side and
  encrypted with **AWS KMS envelope encryption** (one master key; local AES-256-GCM
  fallback so a flaky venue network can't stall the demo). Adapted from a
  production Hedera/KMS pattern to EVM/secp256k1.
- **Free play money**: every new user is dripped **50,000 MONADCOP** (ERC20) + a
  little MON for gas.
- **Allowance-based, refund-free**: buyers *approve* their max budget (proof of
  funds, no tokens move); the market pulls only the negotiated price from the
  winner at the end. Losers are never charged.
- **Commit–reveal reserve**: the seller's reserve is hidden until the reveal —
  even the agent doesn't see it. The reveal proves the negotiated price cleared it.

## Architecture

| Component | Path | Role |
|---|---|---|
| Token | [`contracts/MONADCOP.sol`](contracts/MONADCOP.sol) | ERC20 play-money, 50k drip per user |
| Market | [`contracts/KickoffMarket.sol`](contracts/KickoffMarket.sol) | Listings, NL offers, agent-negotiated pricing, reserve reveal |
| **Agent identity** | [`contracts/AgentIdentityRegistry.sol`](contracts/AgentIdentityRegistry.sol) | **ERC-8004** Identity Registry — the negotiator's on-chain `agentId` + Agent Card |
| Wallets | [`backend/wallets.js`](backend/wallets.js) | KMS envelope encryption (+ local fallback), custodial wallet per user |
| Backend | [`backend/index.js`](backend/index.js) | Express + WS, `/api/join` (wallet+airdrop), `/api/offer` (LLM parses budget, custodial sign), Telegram bot |
| Agent | [`agent/index.js`](agent/index.js) | Scores budget + human story, negotiates final price, `executeWinner` |
| LLM | [`shared/llm.js`](shared/llm.js) | Provider-agnostic — Anthropic Claude **or** OpenAI |
| Frontend | [`frontend/`](frontend/) | React + Vite, bilingual ES/EN. `Offer` = ChatGPT-style Mini App, `Arena` = big-screen feed |

> The original single-prize native-MON version lives in
> [`contracts/KickoffArena.sol`](contracts/KickoffArena.sol) (superseded).

## Stack

Solidity ^0.8.24 · OpenZeppelin · Hardhat · Node + ethers v6 · AWS KMS ·
OpenAI / Anthropic SDK · Express + `ws` · Telegraf · React 18 + Vite · i18next ·
`@twa-dev/sdk` · Monad.

---

## Deployed contracts (Monad testnet · chainId 10143)

| Contract | Address | Explorer |
|---|---|---|
| **MONADCOP** (ERC20) | `0xD8E6798331265b46136198b1ECf492Cb84797acD` | [view](https://testnet.monadexplorer.com/address/0xD8E6798331265b46136198b1ECf492Cb84797acD) |
| **KickoffMarket** | `0xFab111F34cCCBb6212a8788aC322b4A3571072D0` | [view](https://testnet.monadexplorer.com/address/0xFab111F34cCCBb6212a8788aC322b4A3571072D0) |
| **AgentIdentityRegistry** (ERC-8004) | `0x6766d5068e6a16510ca534BAA6bf024eaB77472C` | [view](https://testnet.monadexplorer.com/address/0x6766d5068e6a16510ca534BAA6bf024eaB77472C) |
| KickoffArena (v1, superseded) | `0xD95E49E21952d01374440E4CF5cce43d407E927c` | [view](https://testnet.monadexplorer.com/address/0xD95E49E21952d01374440E4CF5cce43d407E927c) |

- **RPC:** `https://testnet-rpc.monad.xyz` · **Explorer:** `https://testnet.monadexplorer.com`
- **Live app:** https://kickoff.bot · **Big-screen feed:** https://arena.kickoff.bot · **Bot:** [@cryptokickoffbot](https://t.me/cryptokickoffbot)

## Agentic standards — ERC-8004 (Trustless Agents)

The negotiator isn't an anonymous backend script: it has a **real, self-sovereign
on-chain identity** following [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004),
the Trustless Agents standard.

- [`AgentIdentityRegistry.sol`](contracts/AgentIdentityRegistry.sol) is a minimal
  ERC-8004 **Identity Registry** (ERC-721 + URIStorage). Registration is
  permissionless — any agent can `register(agentURI)` and self-issue an identity;
  no central party mints or revokes.
- The kickoff negotiator registered itself **from its own key** (`0x54add8…0B4f`),
  so it **owns** `agentId #1`. The agent — not the operator — controls its identity.
- That `agentId`'s `agentURI` resolves to a live **Agent Card** describing the
  agent's name, capabilities, on-chain identity and supported trust models:
  **[kickoff.bot/agent-card.json](https://kickoff.bot/agent-card.json)** (also at
  the well-known path `/.well-known/agent-card.json`). The card's `registrations`
  block links back to the registry + agentId via CAIP-10, closing the loop:
  on-chain ID → Agent Card → on-chain ID.
- It's surfaced in the product too — the arena shows an **`🆔 ERC-8004 · Agente #1`**
  badge linking to the registry on the explorer.

```solidity
function register(string agentURI) external returns (uint256 agentId);
event   Registered(uint256 indexed agentId, string agentURI, address indexed owner);
function setAgentURI(uint256 agentId, string newURI) external; // agent-only
function getAgentWallet(uint256 agentId) external view returns (address);
```

Reputation and Validation registries (the other two ERC-8004 components) are
out of scope for this deployment; Identity is the foundational primitive.

## Quick start

```bash
npm install                 # contracts + scripts + shared LLM SDKs
( cd backend && npm install )
( cd agent && npm install )
( cd frontend && npm install )

cp .env.example .env        # fill PRIVATE_KEY, AGENT_PRIVATE_KEY, OPENAI/ANTHROPIC,
                            # TELEGRAM_BOT_TOKEN, AWS creds (optional)…

npm run deploy:v2           # deploys MONADCOP + KickoffMarket -> deploy/v2.json
# put TOKEN_ADDRESS / MARKET_ADDRESS (+ VITE_*) into .env

npm run backend             # Express + WS + Telegram bot + treasury
npm run agent               # LLM evaluation + negotiation loop
( cd frontend && npm run dev )

ngrok http 5173             # set WEBAPP_URL + VITE_BOT_URL to the https URL, restart backend
```

### Run the demo

```bash
npm run demo                # create listing, save salt, make QR, open the feed
# … 90s of offers; the agent decides + negotiates automatically …
npx hardhat run scripts/reveal-reserve.js --network monad   # the reserve reveal
```

Big screen at **`/arena`**; the Telegram Mini App opens **`/`**.

## Key wallets (keep separate — avoids nonce races on Monad)

- **PRIVATE_KEY** — deployer / seller / treasury (owns MONADCOP, drips, creates listings).
- **AGENT_PRIVATE_KEY** — the agent (only calls `executeWinner`).
- Per-user custodial wallets — created on demand, KMS-encrypted.

## Monad notes (learned the hard way)

- The public RPC has **no `eth_newFilter`** — events are read via a chunked
  `eth_getLogs` poller ([`shared/poller.js`](shared/poller.js)).
- Monad charges the **gas limit**, not gas used — set limits deliberately.
- A value-transfer + token-mint to the **same fresh account in one block** can
  revert under parallel execution; the backend **retries** (a reverted tx frees
  its nonce, so the retry lands in a later block).
- chainId `10143` is **testnet** (`testnet-rpc.monad.xyz`); `rpc.monad.xyz` is
  mainnet (`143`). Config is env-driven.

## Tests

```bash
npx hardhat test            # KickoffMarket (negotiated pricing, reserve, guards) + KickoffArena
```

## Demo script (≈3m40s)

1. Walk on stage with the football.
2. _"Este balón se va a casa de alguien hoy. No lo decido yo — lo decide un agente de IA en tiempo real sobre Monad. Tienen 90 segundos."_
3. QR → audience scans → Mini App → 50k MONADCOP + a chat box.
4. People type what they want, their budget, and **why**.
5. The agent decides **publicly** — reasoning on screen, weighing price + story.
6. Winner announced, agent **negotiates a lower price** → tx confirms in 0.4s.
7. **REVEAL**: the seller's hidden reserve, the margin, the crowd reacts.
8. Hand the ball to the winner.
9. _"Eso fue Kickoff. Tu agente negocia. Tú ganas. kickoff.bot"_

---

_Forked from `devlabx3/monad-blitz-medellin` (hackathon fork-control). See [`FORK_GUIDE.md`](FORK_GUIDE.md)._
