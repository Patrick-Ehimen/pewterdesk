import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One index.html per page, so every URL is a real file and the site needs
// no rewrite rules wherever it's hosted. They all load src/main.tsx.
export default defineConfig({
  plugins: [react()],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        home: "index.html",
        features: "features/index.html",
        security: "security/index.html",
        download: "download/index.html",
      },
    },
  },
});
