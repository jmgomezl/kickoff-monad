#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# kickoff — one-command demo setup (v2 marketplace)
#   • creates a listing (commits a hidden reserve + saves the salt)
#   • generates a QR pointing at the Telegram bot / Mini App
#   • opens the Arena feed (big screen)
#
# Prereqs: .env filled (MARKET_ADDRESS, TOKEN_ADDRESS, PRIVATE_KEY,
#          AGENT_PRIVATE_KEY/ADDRESS, OPENAI or ANTHROPIC key, ...), deps
#          installed, and the backend + agent + frontend running.
# ─────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f .env ]]; then set -a; source .env; set +a; else
  echo "❌ .env not found. Copy .env.example -> .env and fill it in."; exit 1
fi
: "${MARKET_ADDRESS:?Set MARKET_ADDRESS in .env (deploy v2 first)}"
: "${TOKEN_ADDRESS:?Set TOKEN_ADDRESS in .env}"

RESERVE_MCOP="${RESERVE_MCOP:-15000}"
DURATION_SEC="${DURATION_SEC:-90}"
ITEM_NAME="${ITEM_NAME:-Balón oficial Monad Blitz}"
ARENA_FEED_URL="${ARENA_FEED_URL:-http://localhost:5173/arena}"
QR_TARGET="${VITE_BOT_URL:-${WEBAPP_URL:-http://localhost:5173/}}"

echo "─────────────────────────────────────────────"
echo "⚽  KICKOFF — demo setup (marketplace v2)"
echo "    item     : $ITEM_NAME"
echo "    reserve  : $RESERVE_MCOP MONADCOP (hidden)"
echo "    duration : ${DURATION_SEC}s"
echo "    market   : $MARKET_ADDRESS"
echo "─────────────────────────────────────────────"

echo "▶ Creating listing…"
RESERVE_MCOP="$RESERVE_MCOP" DURATION_SEC="$DURATION_SEC" ITEM_NAME="$ITEM_NAME" \
  npx hardhat run scripts/create-listing.js --network monad | tee /tmp/kickoff-listing.log
LISTING_ID="$(grep -oE 'LISTING_ID=[0-9]+' /tmp/kickoff-listing.log | tail -1 | cut -d= -f2 || true)"
echo "   listing id: ${LISTING_ID:-unknown}"

mkdir -p demo
echo "▶ Generating QR -> demo/qr.png (target: $QR_TARGET)"
if command -v qrencode >/dev/null 2>&1; then
  qrencode -o demo/qr.png -s 12 -m 2 "$QR_TARGET" && echo "   ✅ demo/qr.png"
elif command -v npx >/dev/null 2>&1; then
  npx --yes qrcode "$QR_TARGET" -o demo/qr.png >/dev/null 2>&1 \
    && echo "   ✅ demo/qr.png (npx qrcode)" \
    || echo "   ⚠️  Could not generate QR; the Arena feed shows one on-screen."
else
  echo "   ⚠️  No QR tool; the Arena feed renders a QR on-screen anyway."
fi

echo "▶ Opening Arena feed: $ARENA_FEED_URL"
command -v open >/dev/null 2>&1 && open "$ARENA_FEED_URL" || \
  { command -v xdg-open >/dev/null 2>&1 && xdg-open "$ARENA_FEED_URL"; } || true

echo ""
echo "🎬  Ready. Offers open for ${DURATION_SEC}s."
echo "    • Audience scans the QR → Telegram Mini App → 50k MONADCOP + chat box."
echo "    • The agent auto-decides at the deadline and negotiates the final price."
echo "    • Reveal the reserve for the finale:"
echo "        npx hardhat run scripts/reveal-reserve.js --network monad"
echo ""
