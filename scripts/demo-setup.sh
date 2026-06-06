#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# kickoff — one-command demo setup
#   • creates a fresh arena (commits a hidden min price + saves the salt)
#   • generates a QR pointing at the Telegram bot / Mini App
#   • opens the Arena feed (big screen) in the browser
#
# Prereqs: .env filled (CONTRACT_ADDRESS, PRIVATE_KEY, etc.), `npm install`
#          done at root, and the backend + agent running (see README).
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env
if [[ -f .env ]]; then
  set -a; source .env; set +a
else
  echo "❌ .env not found. Copy .env.example -> .env and fill it in."; exit 1
fi

: "${CONTRACT_ADDRESS:?Set CONTRACT_ADDRESS in .env (deploy first)}"

DURATION_SEC="${DURATION_SEC:-90}"
PRIZE_NAME="${PRIZE_NAME:-Balón oficial Monad Blitz}"
MIN_PRICE_MON="${MIN_PRICE_MON:-0.5}"
COLLATERAL_MON="${COLLATERAL_MON:-0.1}"
ARENA_FEED_URL="${ARENA_FEED_URL:-http://localhost:5173/arena}"
QR_TARGET="${VITE_BOT_URL:-${WEBAPP_URL:-http://localhost:5173/}}"

echo "─────────────────────────────────────────────"
echo "⚽  KICKOFF — demo setup"
echo "    prize    : $PRIZE_NAME"
echo "    minPrice : $MIN_PRICE_MON MON (hidden)"
echo "    duration : ${DURATION_SEC}s"
echo "    contract : $CONTRACT_ADDRESS"
echo "─────────────────────────────────────────────"

# 1) Create the arena (writes demo/salt.json with the reveal secret).
echo "▶ Creating arena…"
DURATION_SEC="$DURATION_SEC" PRIZE_NAME="$PRIZE_NAME" \
MIN_PRICE_MON="$MIN_PRICE_MON" COLLATERAL_MON="$COLLATERAL_MON" \
  npx hardhat run scripts/create-arena.js --network monad | tee /tmp/kickoff-arena.log

ARENA_ID="$(grep -oE 'ARENA_ID=[0-9]+' /tmp/kickoff-arena.log | tail -1 | cut -d= -f2 || true)"
echo "   arena id: ${ARENA_ID:-unknown}"

# 2) Generate a QR code for the Mini App entry point.
mkdir -p demo
echo "▶ Generating QR -> demo/qr.png  (target: $QR_TARGET)"
if command -v qrencode >/dev/null 2>&1; then
  qrencode -o demo/qr.png -s 12 -m 2 "$QR_TARGET"
  echo "   ✅ demo/qr.png"
elif command -v npx >/dev/null 2>&1; then
  # Fallback: use the qrcode npm package on the fly.
  npx --yes qrcode "$QR_TARGET" -o demo/qr.png >/dev/null 2>&1 \
    && echo "   ✅ demo/qr.png (via npx qrcode)" \
    || echo "   ⚠️  Could not generate QR (install 'qrencode' or 'qrcode'). Use the on-screen QR in the Arena feed."
else
  echo "   ⚠️  No QR tool found. The Arena feed renders a QR on-screen anyway."
fi

# 3) Open the Arena feed (big screen).
echo "▶ Opening Arena feed: $ARENA_FEED_URL"
if command -v open >/dev/null 2>&1; then
  open "$ARENA_FEED_URL" || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$ARENA_FEED_URL" || true
fi

echo ""
echo "🎬  Ready. Offers are open for ${DURATION_SEC}s."
echo "    • Audience scans the QR (demo/qr.png or on-screen)."
echo "    • The agent auto-evaluates at the deadline and executes the winner."
echo "    • Reveal the min price for the finale:"
echo "        npx hardhat run scripts/reveal.js --network monad"
echo ""
