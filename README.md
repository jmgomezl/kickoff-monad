# ⚽ kickoff.bot

**Your agent negotiates. You win.** · _Tu agente negocia. Tú ganas._

A P2P **agent-driven negotiation marketplace** on **Monad**. Sellers put up a prize
with a *hidden* minimum price; buyers submit offers — an **amount _and_ an argument** —
and an **AI agent (Claude)** evaluates every offer live, weighing price *and* the
quality of the argument, then executes the winner on-chain. 0.4s finality, near-zero gas.

> Built for **Monad Blitz Medellín** — June 2026.
> The live demo: a real football on stage, a QR code, a Telegram Mini App, 90 seconds
> of offers, an AI agent deciding in front of the crowd, and a dramatic price reveal.

---

## How it works

```
 Seller ──commit keccak256(minPrice, salt)──▶ KickoffArena.sol  (Monad)
 Crowd  ──offer (amount + argument)─────────▶  escrowed bids
 Agent  ──Claude evaluates all offers───────▶  executeWinner(idx, reasoning)
 Seller ──revealMinPrice(minPrice, salt)────▶  THE REVEAL (spread shown)
```

- **Commit–reveal**: the seller's minimum price is hidden until after the winner is
  chosen, so the agent can't be gamed and the reveal stays dramatic.
- **Escrowed offers**: each bid is real MON held by the contract; losers are refunded
  (pull pattern), the winning bid goes to the seller.
- **Anti-fraud collateral**: if the seller refuses to reveal within `REVEAL_WINDOW`,
  anyone can `slashUnrevealed()` to forfeit the collateral to the winner.

## Architecture

| Component | Path | Role |
|---|---|---|
| Contract | [`contracts/KickoffArena.sol`](contracts/KickoffArena.sol) | Commit-reveal arena, escrow, winner execution, collateral |
| Agent | [`agent/index.js`](agent/index.js) | Watches Monad events; at deadline asks **Claude** to pick a winner, publishes reasoning, executes on-chain |
| Backend | [`backend/index.js`](backend/index.js) | Express + WebSocket relay of contract events; **Telegram bot**; relays crowd offers on-chain |
| Frontend | [`frontend/`](frontend/) | React + Vite, bilingual (ES/EN). `Arena` = big-screen feed, `Offer` = Telegram Mini App |

## Stack

Solidity ^0.8.24 · Hardhat · Node + ethers v6 · Anthropic SDK (Claude Sonnet) ·
Express + `ws` · Telegraf · React 18 + Vite · i18next · `@twa-dev/sdk` · Monad.

---

## Quick start

```bash
# 0. Install
npm install                 # root: contracts + scripts
( cd agent && npm install )
( cd backend && npm install )
( cd frontend && npm install )

# 1. Configure
cp .env.example .env        # fill PRIVATE_KEY, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN…

# 2. Deploy the contract to Monad
npm run deploy              # prints CONTRACT_ADDRESS -> put it in .env (and VITE_CONTRACT_ADDRESS)

# 3. Run the stack (separate terminals)
npm run backend            # Express + WS + Telegram bot
npm run agent              # Claude evaluation loop
( cd frontend && npm run dev )

# 4. Expose the frontend over HTTPS for the Telegram Mini App
ngrok http 5173            # set the public URL as WEBAPP_URL + VITE_BOT_URL, restart backend
```

### Run the demo

```bash
npm run demo               # creates an arena, saves the salt, makes a QR, opens the Arena feed
# … 90 seconds of offers; the agent decides automatically …
npx hardhat run scripts/reveal.js --network monad   # the dramatic min-price reveal
```

Open the big screen at **`/arena`**; the Telegram Mini App opens **`/`**.

## Environment

See [`.env.example`](.env.example). Key blockers to clear first:

1. **Fund the wallet** with MON for gas (and the relayer wallet for crowd offers).
2. **Deploy the contract** — everything depends on `CONTRACT_ADDRESS`.
3. **Telegram bot token** from [@BotFather](https://t.me/BotFather).
4. **HTTPS URL** (ngrok or deployed) for the Mini App.

> ⚠️ **Network note:** chainId `10143` is **Monad testnet**. The config is fully
> env-driven (`MONAD_RPC_URL`, `MONAD_CHAIN_ID`) — point it wherever you actually
> deploy. Test MON + near-zero gas makes testnet the natural fit for the demo.

## Tests

```bash
npx hardhat test           # full happy path, wrong-reveal, agent-only, collateral slash
```

## Demo script (≈3m40s)

1. Walk on stage with the football.
2. _"Este balón se va a casa de alguien hoy. No lo decido yo — lo decide un agente de AI en tiempo real sobre Monad. Tienen 90 segundos."_
3. Show the QR → audience scans → Mini App opens.
4. Offers stream in live for 90s.
5. The agent evaluates **publicly** — reasoning on screen.
6. Winner announced → tx executes → 0.4s confirm on the explorer.
7. **REVEAL**: the seller's min price, the spread, the crowd reacts.
8. Hand the ball to the winner.
9. _"Eso fue Kickoff. Tu agente negocia. Tú ganas. kickoff.bot"_

---

_Forked from `devlabx3/monad-blitz-medellin` (hackathon fork-control). See [`FORK_GUIDE.md`](FORK_GUIDE.md)._
