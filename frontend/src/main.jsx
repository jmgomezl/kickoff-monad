import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./i18n";
import "./styles.css";
import Offer from "./pages/Offer.jsx";
import Arena from "./pages/Arena.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Telegram Mini App opens here by default. */}
        <Route path="/" element={<Offer />} />
        {/* Big-screen projector feed. */}
        <Route path="/arena" element={<Arena />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);
