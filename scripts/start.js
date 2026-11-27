#!/usr/bin/env node
// ── Dev entry point (`npm start`) ────────────────────────────────────────────
//
// Brings up server.js via the headless supervisor. See ../local-services.js
// for the orchestration.
import { main } from "../local-services.js";

main().catch((err) => {
  console.error("[local-services] fatal:", err);
  process.exit(1);
});
