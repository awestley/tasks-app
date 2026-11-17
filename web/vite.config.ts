import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const apiTarget = process.env.TASKS_API_URL || "http://127.0.0.1:8000";
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // The app, plus the REST API reference at /docs.
      input: { app: "index.html", docs: "docs/index.html" },
    },
  },
  server: {
    proxy: {
      "/api": apiTarget,
      "/auth": apiTarget,
      "/health": apiTarget,
      "/mcp": apiTarget,
    },
  },
});
