import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Loads VITE_* from the repo-root .env as well as frontend/.env.
export default defineConfig({
  plugins: [react()],
  envDir: "..",
  server: {
    host: true,
    port: 5173,
    // Allow ngrok / tunneled hosts for the Telegram Mini App.
    allowedHosts: true,
  },
});
