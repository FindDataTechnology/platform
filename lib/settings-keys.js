// ── User-facing setting keys (single source) ────────────────────────────────
//
// One list, three consumers — this module exists because the list HAD drifted
// three ways (2026-10-29 finding):
//   electron/config/settings.js  resolveEnv()  — settings.json → child env
//   supervisor/steward-main.js   readSettingsEnv() — the RESIDENT steward is
//       launched by launchd/schtasks with a bare env, so it must read
//       settings.json itself and hand the same keys to the cell + runner
//   local-services.js            headless launcher — .env → agent env
//
// Semantics: every consumer forwards whichever of these keys it finds in its
// own source (settings.json wins over inherited env in the Electron path).
// A key present in the list but absent from the source is simply not
// forwarded. Adding a user-facing knob = adding it HERE, once.
//
// Tokens stay in the main process / child env — never in the renderer
// (project rule: tokens never reach the browser).

export const SETTING_KEYS = [
  // LLM lane
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "DEFAULT_MODEL",
  // Auth (Logto)
  "AUTH_MODE",
  "LOGTO_ENDPOINT",
  "LOGTO_APP_ID",
  "LOGTO_APP_SECRET",
  "LOGTO_CLIENT_TYPE",
  "LOGTO_END_SESSION",
  "SESSION_TTL_HRS",
  // Desktop cell port (the EMBEDDED desktop pins it; the resident world picks
  // a free port — the value only matters to the embedded path).
  "DESKTOP_SERVER_PORT",
  // Search relay (websearch MCP): both must be set or web_search degrades to
  // an explicit "not configured" tool error.
  "SEARCH_RELAY_URL",
  "SEARCH_RELAY_TOKEN",
  // Wanxing fleet plugin (openspec: desktop-fleet-runner). The runner id is
  // minted by first-run bootstrap and rides the same settings file; the
  // switch + registry wiring are user-editable in Preferences.
  "WANXING_PLUGIN_ENABLED",
  "WANXING_PLUGIN_RUNNER_ID",
  "AGENT_SERVING_REGISTRY_URL",
  "AGENT_SERVING_REGISTRY_TOKEN",
  "AGENT_RUNNER_PORT",
  // Local roster feed credential (openspec: add-local-fleet-control-plane):
  // minted by first-run next to the seat id; the CELL verifies it and the
  // runner presents it. Both consumers must see the same value or the feed
  // falls back to its open-on-loopback dev posture.
  "WANXING_LOCAL_FEED_TOKEN",
  // Fleet uplink (slice ③): where this seat reports runner_stats/state events
  // (the customer's Wanxing observer). Absent = the seat is board-invisible.
  "AGENT_RUNNER_FLEET_URL",
  "AGENT_RUNNER_FLEET_TOKEN",
  // Headless-launcher extras (local-services forwards these from .env)
  "DATABASE_URL",
  "PAAS_BASE_URL",
];
