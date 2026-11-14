import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Set VITE_BASE_PATH when the site is served from a subpath, e.g. "/llm-serving-explorer/".
export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false
  }
});
