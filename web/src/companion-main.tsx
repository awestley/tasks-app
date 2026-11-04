// Entry for the companion view (companion.html). Kept apart from main.tsx so it loads only what it needs.
import React from "react";
import { createRoot } from "react-dom/client";
import "@awestley/glassive/tokens.css";
import "@awestley/glassive/accent.css";
import "@awestley/glassive/bundle.css";
import "./glassive-app.css";
import "./companion.css";
import { applyTheme } from "@awestley/glassive";
import { PcProvider } from "@awestley/pc-runtime/react";
import Companion from "./Companion";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PcProvider app="tasks" applyTheme={applyTheme}>
      <Companion />
    </PcProvider>
  </React.StrictMode>,
);
