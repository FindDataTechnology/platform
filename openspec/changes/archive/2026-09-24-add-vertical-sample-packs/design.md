# Design — add-vertical-sample-packs

## Context

Registry live inventory (probed 2026-09-19, read-only via registry MongoDB on cheap1): 143 skills (121 legal, 14 finance-research, 4 data-analysis), 5 MCP servers (`law-bench` 52 contract tools; `fd-open-data-mcp` 45; `fd-cn-report` 44; `fd-daas-mcp` 161; `airegistry-tools` 7), 2 link-mode agent cards (chatlaw/fingpt → GitHub). All four demo-relevant `/mcp` endpoints return 401 without a Bearer JWT — `visibility: public` on fd-* affects listing only. Registry scope model (`mcp_scopes`): only admin groups hold any server access today; no normal-user scope exists. Platform side already has: registry-backed market, role gating via `registry-groups.json` + Logto groups, skill install→materialize hot-reload, cloud agent catalog (`AGENTS_CONFIG_URL`), `agent-remote` chat routing to OpenAI-compatible endpoints, and a working provider at `token.finddatatech.cloud/v1` (`deepseek-v4-pro`, tested 330 ms).

## Goals / Non-Goals

Goals: one install surface per pack; real data behind every pack (or honest degradation); a conversational agent per pack without platform code; reproducible demo run by an operator from the playbook alone.

Non-Goals: platform code (auth automation → registry-sso-credentials); Store-UI "Pack" objects or one-click pack install; bundling packs into the desktop installer; curating the other ~135 registry skills.

## Decisions

### D1: Entry skills are the pack layer — no new platform "pack" object
143 flat skills are unnavigable for customers; a pack needs exactly one thing to install. The entry skill (registry skill, installable via existing market flow) encodes the workflow and references sibling skills and MCP tool groups. Alternative rejected: a Store "Pack" UI object bundling installs — product surface + code, unjustified before the pack concept is validated in demos.

### D2: Skill sources live in this repo, registered into the registry
`docs/vertical-packs/skills/<name>/SKILL.md` is the authoring source of truth; registration into the registry (admin UI or API on cheap1) is a documented ops step in the playbook. Alternatives: bundling into `market-catalog-skills.json` (requires a platform release; registry is the live customer-facing source) or authoring only in the registry UI (no version control) — both rejected.

### D3: MCP guidance is tool-intent based, not tool-name bound
law-bench's exact 52 tool names and fd-* tool lists are not yet enumerated (security-scan `raw_output` for those servers is empty; probing needs a fresh token). Entry skills reference "server + tool intent" (e.g. "law-bench 的条款 RAG 检索"). V2 binding to exact tool names happens only after enumeration, as content edits, not spec changes.

### D4: `fd-legal-search-mcp` — thin retrieval wrapper, provenance-first
New server in FindData's data infra (not this repo): statute + case retrieval over crawl corpora, ~4 tools (`search_statutes`, `search_cases`, `get_statute`, `get_case`), streamable-HTTP MCP, registered into the registry scoped to `legal`. Corpus freshness is out of scope; results carry source + identifier. Alternatives rejected: pointing the case pack at law-bench (contract-only tools), or at fd-open-data-mcp (finance/econ domain) — neither has adjudicated-case or statute data; deferring entirely (leaves the case pack data-less, the gap this closes).

### D5: Agents via cloud catalog with `apiKeyEnv`, not registry, not agents.json
The three chat agents are entries in the `AGENTS_CONFIG_URL` document: live-editable, no platform release, honored by the existing catalog merge and validation. Credential via `apiKeyEnv` (`FD_TOKEN_API_KEY` secret in fd-prod) — never inline (the provider key currently sits in `llm-providers.json`; the catalog document must not repeat that mistake). Registry-side agent registration with OpenAI-compatible endpoints is spec-supported and equivalent, but the registry's agent records are currently link-cards; cloud doc is the lower-friction path. Persona deliberately lives in the entry skill, not the agent entry (agent entries carry no system prompt in the current contract).

### D6: V0 credential step stays manual paste in the playbook
Until registry-sso-credentials lands, the playbook's operator setup includes minting a 168 h JWT per demo account (registry UI "Get JWT Token") and pasting it at MCP install. This is a documented demo-run step, not a customer-facing promise.

## Risks / Trade-offs

- [law-bench scope grant may need more than group membership (earlier admin-token 401 on its MCP route)] → 10-minute spike in tasks: mint admin token, call `/law-bench/mcp`, read mcpgw logs on cheap1 for the exact denial reason before the first demo.
- [`fd-legal-search-mcp` corpus readiness gates the case pack's data story] → pack demos methodology-first until the server registers; playbook marks the data step as conditional, never fakes retrieval.
- [Deep-linking sibling skills by name breaks if registry skills are renamed] → entry skills degrade gracefully (inline method summary) and the playbook lists exact expected names; renames are visible in the registry UI.
- [168 h token expiry mid-demo-season] → V0 runbook re-mints per demo day; V1 (registry-sso-credentials) removes the step.

## Migration Plan

1. Ops: Logto groups + registry scopes + `registry-groups.json` (runbook in playbook).
2. Author + register the 4 entry skills; register 3 cloud agents + secret.
3. Demos run on V0 manual tokens immediately.
4. `fd-legal-search-mcp` lands in data infra → register → case pack gains live retrieval.
5. registry-sso-credentials lands → playbook drops the manual token step.
Rollback: unregister registry entries / remove cloud agent entries / revert `registry-groups.json`; no platform state to migrate.

## Open Questions

- Exact tool names on law-bench / fd-open-data-mcp / fd-cn-report (resolve at first authenticated probe; affects D3 V2 wording only).
- Whether `fd-daas-mcp` (161 tools, dashboard/workflow groups) earns a place in the 数据 packs after tool enumeration — pack tables in the playbook can add it without spec change.
