// Entry for the companion box (companion.html): the same app in its compact layout
// (westley-app docs/companion.md).
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

document.documentElement.classList.add("is-companion");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PcProvider app="tasks" applyTheme={applyTheme}>
      <App companion />
    </PcProvider>
  </React.StrictMode>,
);
