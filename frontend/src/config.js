// Centralized runtime config from Vite env (VITE_*).
const env = import.meta.env;

export const BACKEND_URL = env.VITE_BACKEND_URL || "http://localhost:3001";
export const WS_URL = env.VITE_WS_URL || "ws://localhost:3002";
export const CONTRACT_ADDRESS = env.VITE_CONTRACT_ADDRESS || "";
export const MARKET_ADDRESS = env.VITE_MARKET_ADDRESS || "";
export const TOKEN_ADDRESS = env.VITE_TOKEN_ADDRESS || "";
export const MONAD_RPC_URL = env.VITE_MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
export const MONAD_CHAIN_ID = Number(env.VITE_MONAD_CHAIN_ID || "10143");
export const MONAD_EXPLORER = env.VITE_MONAD_EXPLORER || "https://testnet.monadexplorer.com";
// Where the QR should point (the Telegram bot / Mini App). Falls back to the bot.
export const BOT_URL = env.VITE_BOT_URL || env.VITE_WEBAPP_URL || "";

export function explorerTx(hash) {
  return hash ? `${MONAD_EXPLORER}/tx/${hash}` : "#";
}

export function explorerAddress(addr) {
  return addr ? `${MONAD_EXPLORER}/address/${addr}` : "#";
}
