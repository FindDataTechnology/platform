## Context

See `proposal.md` — Why. Three facts shape this design:

- The four gates already exist server-side and already block publish: annotation shape, tool-surface closure (`pack-tool-declaration-gate`), vocabulary, and the official-pack en-coverage rule. `PackDraftsView` already holds `coverage` and `gateGaps` state, so the information is present — it is reported piecemeal.
- The supply domain has no runtime: `AgentStudioPage` renders under `facet/web/src/StudioView.tsx` against a MemoryRouter, and deploy actions on that host answer 501 with guided wording (documented honest boundary). A preview sandbox would need a whole execution plane inside the supply domain.
- The run domain already has the exact capability: install a pack snapshot into a cell and open a chat. `subscribe → next-steps wizard` is the shipped path.

## Goals / Non-Goals

**Goals**

- A creator can find out what is wrong *before* publishing, in one place, with a way to fix each item.
- A creator can try the thing in the one place that can actually run it, in one action, and come back knowing they tried it.

**Non-Goals**

- No ephemeral sandbox in the supply domain this version (rejected in D2 below).
- No change to any gate's pass/fail rule, to version immutability, or to billing.
- No new execution semantics in the run domain: the handoff uses the shipped install + chat paths.

## Decisions

### D1 — The checklist is an aggregation, not a new gate

One component collects what four gates already computed and renders them as rows: `{where, what, fixHref}`. The publish endpoint's rules are untouched; the panel calls the existing gate collectors and renders their output.

Rejected alternative: a new combined validation endpoint. It would create a second implementation of four rules and drift from them — the same failure mode as the two tab tables.

### D2 — "Try it" is a handoff to the run domain, not a sandbox

The supply domain hands off to 壹座 `/chat` (or the pack detail's install path) carrying the pack reference; execution happens where execution lives. The supply domain records only that a trial was requested, and shows it as "已试用 vN" — never as "运行成功/失败".

Rejected alternative: an ephemeral preview sandbox inside the facet service. It needs model routing, tool execution, credential handling and cost accounting inside a service whose contract is *materials at rest*. It would also give a second, weaker execution path that could disagree with the real runtime — worse than no preview.

Consequence: with no 壹座 session available (self-hosted facet with no platform), the action degrades to guidance describing where a trial can happen. That is the same honest-boundary posture the deploy action already uses.

### D3 — Trial state is a hint, never a gate

"已试用" does not unlock or bypass anything: publish still runs every gate. A creator may publish an untried pack (many packs are configuration-only). The state exists so the UI can suggest the next step, not so it can police.

### D3a — 未发布的草稿不可试，这是结构事实而不是产品裁剪

实施时确认的硬约束：安装路径只收 `{packId, version}`，清单由 cell **服务端**回市场按调用者身份取
（`pack-install-server-side-manifest`）。草稿在首次发布前 `publishedPackId` 为 null，**没有 id
可以交出去**，因此既装不进工作台，也无法通过深链交给运行域。

因此「一试」对未发布草稿的正确行为是**如实说明**（"先发布一版，发布后即可装进工作台试"），
而不是给一个点了必然失败的按钮，也不是在供给域里造一条绕过市场的安装旁路（那会绕过发布闸与
不可变快照，正是本能力要守的东西）。proposal 里「草稿或已发布版本」的措辞据此收敛为
「已发布版本」——这是实施中发现的真实边界，记在此处以便后续若要支持「草稿预演」另立 change
（需要运营域新增一条接受清单体的预演通道）。

### D4 — "Differs from published" is computed from the draft, not stored

The "有未发布改动 / 已与线上一致" line compares the current draft's manifest hash against the last published version's hash, both already available. Storing a dirty flag would be a third thing to keep true.

## Risks / Trade-offs

- **[Checklist becomes noise for a draft with 40 warnings]** → rows are grouped by gate and collapsed by default beyond the first three; the count is always visible, the detail on demand.
- **[Handoff loses the creator's context on return]** → the return path carries the pack id and lands on the same draft; the trial marker is keyed by (pack, version).
- **[Trial marker could read as a quality claim]** → copy says "已试用" (was opened in a workspace), never "已验证" or "可发布".

## Migration Plan

Single deploy on the platform image; the facet shell picks up the new Studio action through the shared component. Rollback is a revert of the panel + action; no data migration, no schema change.

## Open Questions

- Whether the trial handoff should also work from a *published* pack's detail page (not just a draft) — cheap either way, decide during implementation by what the install path already exposes.
