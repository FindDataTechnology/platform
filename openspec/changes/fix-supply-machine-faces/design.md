## Context

See `proposal.md` — Why. Three constraints shape every decision below:

- The plaza (`site-plaza/`, static, `agent.finddatatech.cloud`) and the facet shell (`facet/`, Express SPA, `facet.finddatatech.cloud`) are **two separate deployables** in one image. Neither serves the other today.
- The only machine-surface generator in existence is `scripts/plaza-export.mjs` (gated by G1/G2/G3, writes `site-plaza/generated/`), and its only invoker is the manual `scripts/deploy-plaza.sh`.
- The CLI is published to npm (`@finddatatechnology/facet`), so any CLI change is a release, not just a merge.

## Goals / Non-Goals

**Goals**

- A crawler following the canonical machine paths gets the machine surface, or an honest 404 — never HTML.
- The machine surfaces cannot drift indefinitely behind the live market.
- A user who does not know a pack id can still reach `install`.
- A self-hosted install keeps updating from the marketplace it came from.

**Non-Goals**

- Building a second machine-surface generator on the facet host (rejected in D1).
- Adding `plugin` to the plaza's species enumeration (that is `unify-material-market`'s v2 work; plaza keeps its current enum until a separate change widens it).
- Publishing to the community MCP registry, or making self-hosted MCP work without the out-of-repo registry.
- A search-ranking redesign: `search` reuses the market's existing query semantics.

## Decisions

### D1 — One machine-face host; the shell answers 404

`agent.finddatatech.cloud` (plaza) owns every machine surface. `facet.finddatatech.cloud` returns 404 for `/llms.txt`, `/llms-full.txt`, `/catalog.json`, `/robots.txt`.

The alternative — teaching the facet shell to render machine surfaces — was rejected: it would create a second generator for the same inventory, and the two would drift exactly the way the three doors did before `unify-material-market`. It also cannot produce `catalog.json` without the plaza export's registry reads.

Implementation shape: the shell's catch-all gets an explicit deny list consulted **before** `index.html` is sent. The deny list must be exported so the contract test and the server share one source.

### D2 — Regeneration runs as a scheduled job in the deploy plane, not in the service

The export needs repo access, the sources' APIs, and write access to the static host; the facet service has none of those. So the cadence lives where deploy already lives: a scheduled job that runs `plaza-export` then the `deploy-plaza.sh` publish step.

Cadence: hourly is the wrong unit (the export hits several registries); a few times a day plus an on-demand trigger covers the drift window. The exact schedule is an infra value, not a spec value — the spec only requires "bounded cadence independent of human deploys".

Rejected alternative: a publish-triggered regeneration (event-driven). It is attractive — `unify-material-market`'s publish path could fire it — but it fails exactly when it matters most: historical backfills, registry-side visibility changes, and the export failing silently. Keep the timer as the guarantee; a publish trigger may be added later as an accelerator on top of it.

### D3 — Counts derive from the species enumeration

`buildLlmsTxt` and the `catalog.json` builder read the per-species counts they already compute, and print them under the species names from `supply-catalog`'s enum. The composite "agents" total is removed from the machine surfaces (the human intro may keep a narrative number, which is why the spec update targets machine surfaces only).

The export's existing G1 reconciliation gate is extended to assert the printed counts equal the recomputed ones — a mismatch fails the build rather than publishing.

### D4 — `list` / `search` are thin clients over `/api/packs`

No new server endpoint: the CLI reads the same listing API `install` already uses. Filtering by line maps to the market's `category`/`facets` fields; `--json` prints the server rows untouched so scripted use never depends on our formatting.

Rejected alternative: bundling a catalog snapshot into the npm package. It would make `list` work offline but guarantee staleness, and a stale catalog is worse than an unreachable one (it silently installs the wrong version).

### D5 — The install base is part of the install record

`installed.json` gains `base`. `update` resolves per record: explicit `--base` > recorded `base` > official default. A record without `base` (older CLI) uses the official default **and says so in the report** — the failure mode we are fixing was silent, so the fix must be audible even in its fallback.

### D6 — Fix the dead docs link by publishing the file, not by removing the link

`docs/ecosystem/client-matrix.md` exists locally and is absent from the public repo. Deleting the link would satisfy "no 404" while deleting the capability claim. Instead the matrix lands in the public repo alongside the other guides, and a repository test asserts every docs-view deep-link path exists (checked against the public repo tree at build time, or against a checked-in mirror list when offline).

`#/docs` also gains the self-hosted `--base` form beside the official form, sourced from the same `cliFacts` single source as the command tables.

## Risks / Trade-offs

- **[Cron job duplicates a manual deploy]** → the job runs the same script; `deploy-plaza.sh` is idempotent (tar + scp + atomic dir swap). Overlap is harmless, concurrent runs are serialized by the job's own concurrency policy.
- **[404 on `/robots.txt` hurts SEO before the plaza host is verified]** → ship the plaza root files first, verify all four paths 200 with correct content type, then flip the shell to 404. Order is in the migration plan.
- **[CLI release lag]** → the base-persistence fix only helps users who upgrade. Not a blocker: old CLIs keep today's (wrong) behavior, new ones do not; the docs view tells self-hosters to pass `--base`.
- **[Search semantics differ from a user's expectation]** → `search` prints the market's own match set with its own ordering; we do not re-rank. If the market's search is poor, that is a market concern, not a CLI concern.
- **[Mirror-list test can rot]** → assert against the live public tree when the network is available and fall back to the checked-in list otherwise; a stale list fails only when the link is actually broken.

## Migration Plan

1. Facet shell: add the deny list + contract test. Deploy is safe on its own (404 for paths that were already returning useless HTML).
2. Plaza: ensure `llms.txt` / `llms-full.txt` / `catalog.json` / `robots.txt` land at the host root; verify all four by curl with content-type assertions. **This must be green before step 3.**
3. Plaza: schedule the regeneration job; record one successful automatic run and its advancing timestamp.
4. CLI: `list` / `search` / `base` persistence; npm release via OIDC trusted publishing; then update `#/docs`.
5. Docs: mirror `client-matrix.md` to the public repo; flip the docs-view link test to required.

Rollback: steps 1, 2 and 5 are single-file reverts. Step 3 is a job removal. Step 4 is an npm deprecate + version pin (no unpublish).

## Open Questions

- Whether the publish path should also trigger the export (an accelerator, not a guarantee) — safe to decide after the timer proves the stale window is closed.
- Whether `catalog.json` should carry `plugin` entries before the plaza's species enum widens — depends on `unify-material-market`'s v2 follow-through, outside this change.
