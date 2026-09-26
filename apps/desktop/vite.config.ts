/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port (see devUrl in src-tauri/tauri.conf.json)
// and should own the terminal output.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
  },
  test: {
    // Vitest stubs CSS imports to "" by default; the theme test reads the
    // brand tokens as text (?raw) to check every theme is defined.
    css: { include: [/pewterdesk-tokens\.css/] },
  },
});
