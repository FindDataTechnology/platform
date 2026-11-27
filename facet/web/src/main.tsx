// The shell imports live in the main web app's tree: the tailwind token
// sheet and the i18n init (bundled resources, packs.* keys included) are
// single-sourced there.
import "./facet.css";
import { initI18n } from "@/i18n";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// i18n must be ready BEFORE the tree mounts: the active locale's chunk is a
// dynamic import now (openspec: slim-i18n-payload), so a bare side-effect
// import no longer initializes anything and the shell would render in whatever
// `i18n.language` defaults to. Facet's own e2e `facet-locale-switcher` value
// assertion is what caught this being missed here (2026-11-24).
//
// Degrade rather than block: a failed locale chunk means English, never a
// blank page (product principle 1).
initI18n()
  .catch((e) => console.warn("[i18n] locale bundle failed to load; rendering with the English fallback", e))
  .then(() => {
    createRoot(document.getElementById("root")!).render(<App />);
  });
