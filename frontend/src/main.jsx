import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./i18n";
import "./styles.css";
import Offer from "./pages/Offer.jsx";
import Arena from "./pages/Arena.jsx";

// On the `arena.` subdomain the root shows the big-screen feed; everywhere else
// (kickoff.bot — the Telegram Mini App) the root shows the Offer page.
const isArenaHost =
  typeof window !== "undefined" && window.location.hostname.startsWith("arena.");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={isArenaHost ? <Arena /> : <Offer />} />
        {/* Explicit routes work on any host. */}
        <Route path="/arena" element={<Arena />} />
        <Route path="/offer" element={<Offer />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
