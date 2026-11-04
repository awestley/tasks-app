// Entry for the full app (index.html). The companion box uses companion-main.tsx with the same App.
import React from "react";
import { createRoot } from "react-dom/client";
import "@awestley/glassive/tokens.css";
import "@awestley/glassive/accent.css";
import "@awestley/glassive/glassive.css";
import "./glassive-app.css";
import "./style.css";
import { applyTheme } from "@awestley/glassive";
import { PcProvider } from "@awestley/pc-runtime/react";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PcProvider app="tasks" applyTheme={applyTheme}>
      <App />
    </PcProvider>
  </React.StrictMode>,
);
