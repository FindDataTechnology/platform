# add-vertical-sample-packs

## Why

The hosted platform (fd-prod) sells into vertical industries (legal, finance/data), and the registry already holds a deep content library (143 skills, 5 MCP servers, 2 agent cards) — but it lies flat: a customer sees 143 undifferentiated skills and must hand-assemble MCP + skills + agent into a working assistant. We need customer-demoable "vertical packs" (法律-合同, 法律-案件, 数据-股票, 数据-中国经济) that assemble existing registry resources into one-entry workflows, and the packs must actually run end-to-end for a logged-in customer: MCP calls authenticated, a real conversational agent, and the case pack needs a data backend that does not exist yet.

## What Changes

- **4 pack entry skills** authored and registered into the registry (`legal-contract-workflow`, `legal-case-workflow`, `stock-research-workflow`, `china-macro-brief-workflow`): each is the pack's discovery + orchestration layer — one install yields a complete industry workflow that calls out to the pack's existing skills and MCP tools by name.
- **New MCP server `fd-legal-search-mcp`** (法条 + 类案检索, ~4 tools) built from FindData crawl corpora, registered into the registry and scoped to the `legal` group — closes the "案件包无数据底座" gap; until it lands, the case pack demos skill-driven analysis only.
- **3 chat-mode vertical agents** (合同审查官 / 案件分析师 / 行业分析师) registered via the cloud agents catalog (`AGENTS_CONFIG_URL`), pointing at the existing OpenAI-compatible endpoint `token.finddatatech.cloud/v1` (model `deepseek-v4-pro`), credentials referenced via `apiKeyEnv` only — replaces the hollow chatlaw/fingpt link cards as the conversational entry (link cards stay as ecosystem showcase).
- **Registry-side authorization provisioning** (ops, not code): Logto groups `legal` / `analysts`; registry scope groups granting `law-bench` to `legal` and the three `fd-*` servers to `analysts` + `legal` — today only admin scopes exist, which is why every non-admin MCP call 401s.
- **`registry-groups.json` visibility mapping** on fd-prod so the Store shows each pack's entries to the right role.
- **Demo playbook** `docs/vertical-packs.md`: per-pack composition, install path, canned demo inputs, and the token/credential step for V0 (manual paste) until registry-sso-credentials lands.
- Pack skill sources live in this repo under `docs/vertical-packs/skills/` as the authoring source of truth; registration into the registry is an ops procedure documented in the playbook.

Non-goals: no platform code in this change (auth automation is registry-sso-credentials); no bundling of packs into the desktop installer; no marketplace "Pack" object in the Store UI.

## Capabilities

### New Capabilities

- `vertical-packs`: the pack model — what a vertical pack is (entry skill + MCP set + agent + role), the four concrete pack definitions, their composition contracts, and the demo playbook requirements.

### Modified Capabilities

(none — the three vertical agents are catalog data conforming to the existing `agent-catalog` contract: cloud-sourced `agent-remote` `chat` entries with `apiKeyEnv` credential references need no spec change.)

## Impact

- **Registry (ops)**: register 4 skills + 1 new server (`fd-legal-search-mcp`) + scope groups; no registry code changes.
- **Logto (ops)**: create groups `legal`, `analysts`; assign customer accounts.
- **fd-prod (ops)**: `registry-groups.json`, `AGENTS_CONFIG_URL` doc, `FD_TOKEN_API_KEY` secret.
- **Data infra (code, separate repo)**: build `fd-legal-search-mcp` against crawl corpora.
- **This repo**: `docs/vertical-packs.md` + `docs/vertical-packs/skills/*.md`; no runtime code.
