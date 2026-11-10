import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./i18n"; // side-effect: initializes i18next before <App/> renders
import "./lib/core-wiring"; // side-effect: wires the shared core's error sink + dev store seam
import App from "./App";
import { ShellErrorBoundary } from "@/components/ShellErrorBoundary";
import { loadAppConfig } from "./hooks/useAppConfig";
import "./styles/globals.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// The deployment's name (ASSISTANT_NAME) is resolved BEFORE the first paint so
// the sidebar, turn header and placeholder never flash the localized default,
// and the tab title carries the same name. The fetch is time-boxed inside
// loadAppConfig, so a slow or unreachable server costs one brief wait, never a
// blank page.
void loadAppConfig().then((config) => {
  if (config.assistantName) document.title = config.assistantName;
  // Tab favicon: inject only when a brand icon is configured — unset keeps
  // today's default (no icon link, browser default tab icon).
  if (config.brandIconUrl) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = config.brandIconUrl;
  }
  createRoot(rootEl).render(
    <StrictMode>
      {/* Outer render boundary (openspec: harden-spa-shell-resilience): the
          last-resort catcher — a crash in the layout itself degrades to the
          shell error card, never a blank document. Route-level crashes are
          caught by the inner boundary in App.tsx, which keeps the rail. */}
      <ShellErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ShellErrorBoundary>
    </StrictMode>,
  );
});
