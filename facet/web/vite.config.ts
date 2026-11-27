import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The thin facet SPA reuses the 壹座 web app's packs surface verbatim — the
// alias points INTO the main app's source tree (web/src), so
// components/packs, the ui kit, i18n resources, and the tailwind tokens stay
// single-sourced. Facet adds only the shell (header, login state).
const WEB_SRC = path.resolve(import.meta.dirname, "../../web/src");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Both trees ship their own node_modules copies of these (facet/web deps
    // and web deps, installed separately): without dedupe each runtime lands
    // in the bundle twice. Two react-i18next copies silently break the
    // instance registry the shell relies on (useTranslation returns raw
    // keys), and two React copies would break hooks outright. Force one copy
    // — resolved from facet/web's root, which owns this build.
    // react-router(-dom) rides the same rule: the @ alias pulls web/src pages
    // whose 'react-router-dom' imports would otherwise resolve from
    // web/node_modules while StudioView's own import resolves from
    // facet/web/node_modules — two router copies = two Router contexts, and
    // the studio face dies on "useNavigate() may be used only in the context
    // of a <Router>" (2026-11-07 #/studio production incident).
    dedupe: [
      "react",
      "react-dom",
      "react-router",
      "react-router-dom",
      "i18next",
      "react-i18next",
    ],
    alias: {
      "@": WEB_SRC,
    },
  },
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8080",
      "/auth": "http://localhost:8080",
    },
  },
});
