import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const apiTarget = process.env.TASKWELL_API_URL || "http://127.0.0.1:8000";
export default defineConfig({
  plugins: [react()],
  // Relative URLs, so one build works at the root and under the shell's /apps/tasks/ path.
  base: "./",
  build: {
    rollupOptions: {
      // embed.js is loaded by other apps (through <pc-embed>), so it keeps a fixed name.
      input: { index: "index.html", embed: "src/embed.ts" },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "embed" ? "embed.js" : "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    proxy: {
      "/api": apiTarget,
      "/auth": apiTarget,
      "/health": apiTarget,
      "/mcp": apiTarget,
      "/manifest.json": apiTarget,
    },
  },
});
