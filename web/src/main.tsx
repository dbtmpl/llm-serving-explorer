import React from "react";
import { createRoot } from "react-dom/client";
import { LiveView } from "./live/LiveView.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LiveView />
  </React.StrictMode>
);
