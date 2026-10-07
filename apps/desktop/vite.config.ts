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
    // The bundled token logos stay files, however small: `bundledLogo`
    // fetches them, and the CSP's connect-src allows 'self' but not data:,
    // so an inlined one would fail to load in the built app.
    assetsInlineLimit: (file) => (file.includes("/assets/tokens/") ? false : undefined),
    // Two pages: the app, and the launch splash window's own tiny page.
    rollupOptions: {
      input: { main: "index.html", splash: "splash.html" },
    },
  },
  test: {
    // Vitest stubs CSS imports to "" by default; the theme test reads the
    // brand tokens as text (?raw) to check every theme is defined.
    css: { include: [/pewterdesk-tokens\.css/] },
  },
});
