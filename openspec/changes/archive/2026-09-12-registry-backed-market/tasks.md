## 1. Spike: pin the live registry contract

- [x] 1.1 Probe the deployed registry with the real service token (`GET /api/servers?include_tools=false`, `GET /api/skills`, `GET /api/agents`, one `GET /api/skills/{path}/content`) and record the field mapping in `design.md` (entry name/description/category, per-entry group metadata presence, gateway URL shape, skill content format). Verify: mapping notes committed; if entries lack group metadata, decide the `registry-groups.json` fallback here (D-risk) before any adapter code.

## 2. Registry bridge module

- [x] 2.1 Create `registry-bridge.js` with env config (`MARKET_REGISTRY_URL`, `MARKET_REGISTRY_TOKEN`, `MARKET_REGISTRY_TTL_SECS=300`), single-flight fetches, 10s timeout, last-good caches, signature-change detection, and `initRegistryBridge({broadcast})` wiring a TTL timer + `market_changed`/`catalog_changed` broadcasts. Verify: unit test — no URL configured ⇒ no fetch/timer and accessors return empty; unreachable URL after a good fetch ⇒ last-good kept + warning logged.
- [x] 2.2 Implement adapters `getMarketEntries()` (servers → mcp catalog entries with `{url, headers:{Authorization:"Bearer <your_token>"}}` templates + groups; skills → metadata-only entries with `origin:"registry"` + `contentPath`) and `getSkillContent(path)`. Verify: unit tests against a mocked registry response shape from task 1.1, including an entry missing optional fields degrades gracefully (dropped with warning, rest served).

## 3. requiresConfig covers header placeholders

- [x] 3.1 Extend `isPlaceholderArg`/`requiresConfig` in `extension-store.js` to scan header values for placeholders, and mirror the rule in the client setup-form field generation. Verify: unit test — `{url, headers:{Authorization:"Bearer <your_token>"}}` derives `requiresConfig: true`; a plain `{command,args}` template is unchanged; client form shows a labeled token field for the gateway template.

## 4. Market integration

- [x] 4.1 Merge registry entries into `getMarketCatalog()` (bundled wins on name collision; registry entries join the ready-to-use/needs-config sort) and make `GET /api/extensions/market` user-aware (registry entry visible iff `entry.groups ∩ user.groups`, group-less registry entries visible to all, bundled always visible; auth off ⇒ only group-less registry entries). Verify: API tests for member/non-member/auth-off cases.
- [x] 4.2 Add the skill install route `POST /api/extensions/market/skills/:name/install`: resolve the registry skill, fetch content server-side, create via `addCustomSkill` + SKILL.md materialization, broadcast `extensions_changed`; 404 for unknown names, error (no partial skill) on content-fetch failure. Verify: integration test — install creates the skill, appears in `/api/extensions/skills`, and a fetch failure leaves the store untouched.

## 5. Agent catalog integration

- [x] 5.1 Extend `catalog.js`: merge registry agents (D7 mapping — link-mode default, `chat` only for declared OpenAI-compatible endpoints with `apiKeyEnv`; groups → `roles`) into the source order built-in → registry → `agents.json` → cloud, joining the existing `CATALOG_REFRESH_SECS` refresh + signature broadcast. Verify: unit tests — registry entry visible per roles; `agents.json` beats registry on id collision; registry outage keeps last-good.

## 6. Web UI

- [x] 6.1 Market view: render registry-sourced cards with a source badge, wire registry skills to the new server-side install route, and refresh the market on `market_changed`. Verify: Playwright test — registry card renders, install lands in the Installed tab, gated entries absent for a non-member user fixture.

## 7. Docs and operator notes

- [x] 7.1 Document env vars in `.env.example` and an operator section in the README (token scope advice, Logto group-naming convention shared by forward-auth groups and registry `group_mappings`, degradation behavior). Verify: doc check — a new operator can enable the registry source using only the README.
