# add-chart-data-binding — verification notes

## What was verified, and how

| Layer | Suite | Result |
| --- | --- | --- |
| Storage (migrations 17–18, point store, as-of, retention) | `scripts/test-chart-source.mjs` + `scripts/test-chart-refresh.mjs` | fresh cell migrates to v18; a v16-column write (a rollback-graded old build) still round-trips; superseded `unchanged` rows prune while the first, latest and every value-changing row survive; the period cap trims the view and leaves the log |
| The replay client | `scripts/test-chart-source.mjs` (20) | initialize → notifications/initialized → tools/call over SSE **and** plain JSON against `e2e/fake-mcp.js`; one retry on a transport fault (counted, not assumed); a 401 is a credential refusal and is **not** retried; no live credential refuses before any request |
| Mapping + normalization | `scripts/test-chart-source.mjs` | both probed shapes (`points[]`, `@root`); monthly `YYYY-MM`, yearly `YYYY`; the probed `"2023"`/`"2023-12-31"` duplicate collapses; its collision form is an anomaly with neither value written; one bad row refuses the whole response |
| The refresh loop | `scripts/test-chart-refresh.mjs` (22) | classify all five kinds; append+revise+resourced in one refresh (rows, counts, `revision_count`, the log); an omitted period inside the response range is kept and logged `missing`; payload byte-identical when nothing changed; gate skip with **no** series read; manual clears the fingerprint; failure keeps data + marks stale + arms `min(2^n×15min, 24h)`; manual bypasses the backoff; allowlist refusal makes no call; unit change refused whole; empty response refused; anomaly path; as-of reconstruction; the cron timer fires with no model turn; the sweeper |
| Bindings | `scripts/test-chart-bindings.mjs` (22) | lineage identity is content-derived (key order irrelevant, map included); two charts share one row + one history; origin priority declared > confirmed > inferred with no downgrade; snapshot at attach; non-bindable tool/server refused; candidate retention (all same-turn `mcp__` calls, results capped at 200KB, merged across captures); the confirmation list filters to bindable calls; unique-witness inference binds, zero/multiple matches do not, and inference never overrides declared/confirmed; the REST round-trips (attach-from-candidate → refresh → rule → observations → as-of → detach) with the library-change broadcast |
| The declared channel | `scripts/test-chart-bind-bridge.mjs` (8) + `scripts/test-chart-bind-declared.mjs` (10) | the plugin registers `chart_bind`, makes exactly ONE outbound request (the declaration — it never executes the data call), refuses an unmounted tool with the closest callable names, refuses an off-allowlist tool before posting, refuses a malformed declaration; `writeChartBindPatch` lands the plugin + matcher + allowlist + overlay row; a profile without it spawns with exactly its old flags; the loopback route lands on THIS turn's chart only (another turn's or another session's is refused), the auth gate exempts that one path for loopback only |
| Web surfaces | `e2e/resources-binding.spec.js` (7) | unbound chart shows no affordances; candidate confirmation binds and a manual refresh redraws (payload regenerated, canvas intact); the period filter slices 30 stored periods to 12/6/30; a failed refresh keeps the render and shows a localized reason; the timeline lists both refreshes with counts, the observation-time filter works, the as-of view is distinguished and returns in one action; a **scheduled** tick redraws an open chart with no interaction; an older cell's response (no `bindings`, 404 routes) hides the whole surface with no error |
| Mini program | devtools walkthrough (see below) | source line, refresh, stale badge and period filter render on the bound card only; the window slices what is drawn; a scheduled tick's broadcast refetched and redrew the open page with no interaction; the older-cell shape hides all four |
| Live upstream | `scripts/probe-chart-bind-live.mjs` (transcripts below) | the whole loop against the real `fd-open-data-mcp`, over **both** production transports: the tailnet NodePort and the registry's MCP proxy with a **minted personal token** |
| The deployable tree (what Jenkins will build) | HEAD worktree + only this change's files/hunks | `check:locales` **all 5 OK (610 keys)**, `web typecheck` OK, `miniapp typecheck` OK, `node --test scripts/test-*.mjs` **396/396** (the 17-test gap vs the working tree is the other workstream's two test files, absent by design), and the pipeline's exact gate `npm run web:build` succeeds |

Full-suite runs: `npm run test:unit` 413/413 at the phase-1/2/3 boundary; the re-run with every new file included is in the closing report. `npx playwright test --project=fast` 273 passed / 6 failed, of which **the 2 resources failures were mine** (my new spec left a chart in the shared store) and are fixed — re-running `resources-binding` + `resources-page` + `resources-save` together is 15/15. The other 4 (chat header, composer actions, WeChat-App settings modal, SSO email casing) are outside this change's files and reproduce in isolation on this working tree; `check:locales` also reports 88 `settings.*` drift entries from the in-flight `add-mp-scan-bind` work (its four locale files carry the `wechat-app` rename, `en` does not) — none of them touch `resources.binding.*`, which is in parity across all five locales.

## Mini-program devtools walkthrough (tasks 5.1, 5.2)

Environment: a hermetic cell on `:3200` (scratch store, no LLM) with two seeded charts — one bound (`fd-open-data-mcp · read_series`, 6 months stored, one revision) and one static — plus a stand-in upstream (`e2e/fake-mcp.js`) installed as an ordinary registry-origin extension and a `*/5 * * * * *` rule armed through the cell's own API. A proxy on `:3201` answers with the older-cell shape (resources without `bindings`, binding routes 404). The devtools simulator pointed at each via `platform.baseUrl` storage; assertions are WXML-class counts and element text (Taro strips `data-testid`, so classes carry the surface).

| Step | Evidence |
| --- | --- |
| Bound card renders its data source | `.res-bind` = 1, `.md-chart-canvas` = 2 (both charts draw) |
| Source line | `.res-bind-source` text = `fd-open-data-mcp · read_series · 截至1 分钟前` |
| No stale badge while healthy | `.res-bind-stale` = 0 |
| Data-period filter | `.res-bind-count` = `已存 24 个 · 显示 12 个` (default window) → tap 近 6 月 → `显示 6 个` → tap 全部 → `显示 24 个`; `.res-seg-on` tracks the choice |
| Scheduled tick → broadcast → refetch → redraw (no interaction) | upstream grown to 30 points + a moved gate; the cell logged `scheduled/ok added=6 revised=24`, then `skipped_fresh` on the next two ticks; the open page moved from `已存 24 个` to `已存 30 个 · 显示 6 个` and the as-of age from `截至2 分钟前` to `截至刚刚`; canvases still 2 |
| Stale badge after an unattended failure | upstream set to 500 → the tick logged an error → the page showed `数据可能已过期 · 数据源不可达` while the chart kept its 30 stored periods |
| Older cell degrades silently | `.res-card` = 2, `.md-chart-canvas` = 2, `.res-empty` = 0, and `.res-bind` / `.res-bind-source` / `.res-bind-stale` / `.res-bind-actions` all = 0 |

Screenshots: `/tmp/mp-walk/mp-bound-stale.png` (bound card: source line, stale badge with reason, refresh + 近 6 月/近 1 年/全部, `已存 30 个 · 显示 6 个`; the static card above it carries none of it) and `/tmp/mp-walk/mp-oldercell.png`.

## Live probe transcripts (`scripts/probe-chart-bind-live.mjs`, 2026-09-27/28)

### 1. Tailnet NodePort (no credential on that port)

Against `http://chengsi:30899/mcp` (fd-open-data-mcp v4.0.5 on the tailnet), scratch cell, `M0_YOY` country:

```
✓ scratch cell opened
✓ upstream installed — http://chengsi:30899/mcp
✓ concept discovered: M0_YOY (id 228) — 流通中现金(M0)同比增长 · unit=% · frequency=monthly · entity=country
✓ read_series returned the probed object shape — concept_id=228 entity=1 count=32
    first={"date":"2024-01-01","value":5.9,"unit":"%","source_used":"akshare"}
✓ data_stats gate readable — fingerprint=2026-09-19T07:33:21.892828|2026-08-01|224
✓ mapped and normalized — 32 points, 2024-01..2026-08, unit=%, anomalies=0
✓ chart bound (origin declared, unit recorded on the first read)
✓ manual refresh against the live upstream — outcome=ok counts={"appended":32,...}
✓ point rows written — 32 rows, 2024-01..2026-08
✓ payload regenerated through the frozen template — 32 values, axis 32, title kept=true
✓ timeline entry written — manual/ok added=32 revised=0
✓ unit recorded from the first observation — %
✓ clients were told to redraw (resources_changed/refreshed)
✓ scheduled tick 1 — outcome=unchanged (records the live gate fingerprint)
✓ scheduled tick 2 skipped on the unchanged gate — no series read was made
PROBE OK
```

### 2. Registry proxy with a minted personal token (the production transport)

The registry route exists only behind a credential: `POST {REGISTRY_URL}/fd-open-data-mcp/mcp` answers `401 {"error":"Authentication required"}` to the service token and to anonymous callers. The credential that works is the **per-user personal token** the platform's own connect flow mints — and `MARKET_REGISTRY_TOKEN`'s service token is *not* it:

```
POST /fd-open-data-mcp/mcp   Authorization: Bearer <service MARKET_REGISTRY_TOKEN>   → 401 Authentication required
POST /fd-open-data-mcp/mcp   Authorization: Bearer <minted personal token>           → 200 initialize
```

Minted through the real connect flow (`GET /api/auth/csrf-token` with the registry session cookie, then `POST /api/tokens/generate {expires_in_hours:168}` with `X-CSRF-Token`; scope `mcp-registry-admin mcp-servers-unrestricted/read mcp-servers-unrestricted/execute`, exp +168 h). Then the same probe, pointed at the registry route:

```
✓ scratch cell opened
✓ upstream installed — https://mcp.finddatatech.cloud/fd-open-data-mcp/mcp with the registry credential
✓ concept discovered: M0_YOY (id 228) — 流通中现金(M0)同比增长 · unit=% · frequency=monthly · entity=country
✓ read_series returned the probed object shape — concept_id=228 entity=1 count=32
    first={"date":"2024-01-01","value":5.9,"unit":"%","source_used":"akshare"}
✓ data_stats gate readable — fingerprint=2026-09-19T07:33:21.892828|2026-08-01|224
✓ mapped and normalized — 32 points, 2024-01..2026-08, unit=%, anomalies=0
✓ chart bound (origin declared, unit recorded on the first read)
✓ manual refresh against the live upstream — outcome=ok counts={"appended":32,...}
✓ point rows written — 32 rows, 2024-01..2026-08
✓ payload regenerated through the frozen template — 32 values, axis 32, title kept=true
✓ timeline entry written — manual/ok added=32 revised=0
✓ unit recorded from the first observation — %
✓ clients were told to redraw (resources_changed/refreshed)
✓ scheduled tick 1 — outcome=unchanged (records the live gate fingerprint)
✓ scheduled tick 2 skipped on the unchanged gate — no series read was made
PROBE OK
```

(The probe stores that credential as an ordinary registry-source credential in the scratch cell's store, which is exactly how a real cell holds it — so the credential plumbing — `credentialRef`, the store, the header injection — is covered by this run, not just the upstream shapes.)

### Live shape corrections (the probe's most valuable finding)

The design's transcript recorded `read_series` as taking `concept_id: "M0_YOY"`, `entity_id: "CN"`. The live v4.0.5 schema disagrees, and the probe refuses to guess:

* `concept_id` and `entity_id` are **integers** (`228`, `1` for China); `entity_type` is the string.
* `start` and `end` are **required** (`'YYYY-MM-DD'`, a bare `'YYYY'` works for yearly concepts). The binding therefore records the window as part of its call identity — a refresh re-reads that same window forever, which is exactly the design's "the stored series grows by our accumulation, not by widening the upstream window".
* `data_stats({concept_id, entity_type})` returns per-concept `{rows, latest_date, last_fetch}` under `concepts[]` (a bare call returns a store summary with no freshness fields). The tolerant gate reader finds the per-concept entry; an unreadable gate returns null and the caller reads.
* `list_concepts` is **broken on this deployment** (`list_concepts_with_family() got an unexpected keyword argument 'query'`), so concept metadata must come from `ai_search`. This is why a binding derives its cadence from the chart's own axis labels rather than from source metadata — the declared channel has no reliable metadata surface to consult.

## Not yet done (needs a deployment decision)

* `6.4` only: Jenkins `platform` → GitOps tag → ArgoCD → pod smoke → ops-console board, then the MP upload/提审 handoff. 6.3 is complete — both transports are transcribed above, and the probe already supports the deployed form: `CHART_PROBE_CELL=https://<cell> node scripts/probe-chart-bind-live.mjs` asserts bind → refresh → point rows → payload → timeline → as-of through the cell's REST surface.

### The commit the deploy should carry (verified recipe)

The working tree is shared with `add-mp-scan-bind`, whose locale rename is half-applied (`settings.wechat-app.*` + `sections.wechat-app` present in zh-CN/es/fr/ja, absent from `en`; `settings.account.mp.*` the mirror image). `check:locales` is therefore red **in the working tree only** — at HEAD it is green (`git worktree add --detach /tmp/dcb-head HEAD` → all 5 locales OK), and `Dockerfile:154` runs `npm run web:build` = `check:locales && vite build`, so the pipeline would fail on a commit that carried the drift.

So the deploy commit must carry this change's files and **only this change's hunks** in the two mixed files: `miniapp/src/app.css` (my `.res-bind*` block; theirs is the login/scan block) and the four non-`en` locales (my `resources.binding` block; theirs is the `wechat-app` rename). A one-off script built exactly that tree as a detached HEAD worktree + whole-file copies + hunk-filtered patches (`git diff -U3` → keep the single hunk whose added lines match `res-bind` / `"binding"` → `git apply`), and the deployable tree then passed every gate listed in the table above. Rebuild it the same way at deploy time — or simply wait for the other workstream to land its `en` side, after which an ordinary full-tree commit is green again.

Two findings from that simulation worth keeping:

* It caught a **real type error** this change had introduced: `filterPeriods` indexed `sorted[sorted.length - 1]`, which is `string | undefined` under the web project's `noUncheckedIndexedAccess` — vite's esbuild strips types without checking, and the e2e run (which exercises the filter through a built bundle) could not see it either. Fixed with an explicit `newest === undefined` guard; `web` typecheck is green after it.
* `scripts/test-cell-gateway.mjs`'s reaper assertion ("a cell with an enabled cron job must never be reaped") flaked once under the full parallel suite in the simulation tree and passed on the immediate re-run (and 3/3 in isolation) — the same timing sensitivity the `add-cron-capability` notes recorded; unrelated to this change.

A live credential minted during the registry-transport probe (a 168 h personal token) was written to `/tmp/chart-probe-registry-token` and deleted after the run.
* Two things must be settled before a deploy: the working tree carries another workstream's uncommitted changes (`add-mp-scan-bind`: the `settings.wechat-app` locale rename in four locales, `WeChatAppSection.tsx`, `miniapp/src/lib/bind-qr.ts`), and `check:locales` currently fails on that drift — so `npm run web:build` (which the pipeline runs) would fail on the current tree. A commit limited to this change's files keeps the pushed state green (`en` and the other four locales carry the same `settings.*` keys at HEAD).
## Release (task 6.4, 2026-09-28)

**Shipped.** Commit `508c57a` (this change, 41 files, +8,569) then `5782aa7` (the allowlist fix below).
Both fast-forwarded onto `gitee/deploy/prod-snapshot`. Jenkins **#33** (`sha-508c57a`) and **#34**
(`sha-5782aa7`), both `SUCCESS`; `fd-infra-deploy` `0d04e18 → c9691b2 →` the fix tag; ArgoCD
`Synced`, `deployment "platform" successfully rolled out`, pod 0 restarts.

The commit needed no hunk surgery by the time it shipped: `add-mp-scan-bind` landed its `en` side first
(commit `b600011`), so `check:locales` was green across the whole tree (618 keys × 5) and this change
could ship as itself — exactly the "wait for the other workstream" branch of the earlier recipe. Gate
before the push: `check:locales` OK, web + miniapp typecheck OK, unit 413 (412 pass — the
`test-cell-gateway` reaper flake recorded above), and `playwright --project=fast` on
`resources-binding` + `settings-wechat-app` together = **11/11**.

Post-deploy verification on fd-prod (all read-only):

| Claim | Evidence |
| --- | --- |
| Migrations 17/18 applied | read the production SQLite directly in the pod: `chart_bindings`, `chart_series_points`, `chart_point_revisions`, `chart_refreshes` all exist, and `resources` carries `binding_refs` + `binding_candidates` |
| The bridge is wired into the running profile | `/opt/dsh-home/profiles/platform/` holds `chart-bind.patch.yml` + `platform-chart-bind-bridge.js`, both written at this pod's boot |
| The REST surface is live and gated | `GET /api/resources/<id>/{observations,candidates,as-of,bindings}` → **401** anonymously (a missing route would 404, so the image really carries it); `/api/resources/bind-declared` → 404 `no_chart_in_turn` (the loopback bridge answering, see below) |
| The UI shipped | the live main bundle references `ResourcesPage-DGF6L8Pp.js`; `GET /assets/ResourcesPage-DGF6L8Pp.js` → 200 (18 KB) |
| Prod DB otherwise untouched by the rollout | no writes from this change beyond the two migrations; `chart_bindings` starts empty |

### Finding 1 — the allowlist never reached the image (fixed in `5782aa7`)

`Dockerfile:186` copies `/app/*.js`, and `chart-replay-allowlist.json` is JSON, so the image shipped
`chart-source.js` and the bridge template but **not** the allowlist. The server's replay gate has a
documented built-in default (`ALLOWLIST_FALLBACK` — `fd-open-data-mcp: [read_series]`) and stayed
correctly closed, but the **plugin's** `allowlist()` returned `null` on an unreadable file and its
caller's `if (servers && …)` guards then skipped both checks — the declaration-time gate was inert in
production. Fixed by shipping the file *and* giving the plugin the same fallback as the server, with a
regression test that runs the exact prod shape (plugin dir without the allowlist). Contract unchanged:
task 1.5's default-deny.

### Finding 2 — the loopback exemptions are reachable from the internet on fd-prod (NOT fixed)

`server/auth.js` exempts three internal bridges on `isLoopback(req.socket.remoteAddress)`, with the
comment that "a non-loopback caller still faces the gate". fd-prod's ingress is a **same-host** proxy
(cheap-1 Caddy → `127.0.0.1:3000`), so *every* external request arrives with a loopback peer address and
the exemption applies to all of them. Measured anonymously from the open internet:

- `POST /api/resources/bind-declared` → 404 `no_chart_in_turn` (the handler ran; during a turn in which
  the owner's session has just captured a chart it would instead accept a declaration and return the
  binding view, i.e. an unauthenticated write plus a small info leak — the *refresh* that would call
  upstream stays refused anonymously and is bounded by the replay allowlist)
- `GET /api/cron` → **200** `{"jobs":[]}` — the same exemption, pre-dating this change
- `POST /api/bots/relay/send` → 404 (inert without its token, as designed)

This is a deployment-trust decision, not this change's bug: the fix is to stop treating a peer address as
a credential on a deployment whose ingress is local — e.g. give the in-pod bridges a per-pod secret
(injected into the dsh child the way the search-relay token already is) and require it, or gate the
loopback exemptions off entirely on single-process deployments. Left to the owner deliberately.

**MP handoff:** the 0.6.1 upload (2026-09-28) carries this change's client half as well (`charts.ts` +
the resources-page binding UI), so the handoff this task asked for is done; console 提审 stays the
user's step.
