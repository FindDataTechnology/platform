## Context

See `proposal.md` — Why. `lib/pack-manifest.js` is the single validator shared by the facet publish endpoint and the cell's install path (`installPack` re-validates the browser-submitted manifest). It already models `mcpServers[].allowTools` (≤64 leaf names, `[A-Za-z0-9._-]{1,128}`) and role-level `agents[].resources.mcpTools` (narrowing only). The facet publish path (`facet/`) layers registry checks on top: snapshot `tool_list`, a live `initialize` + `tools/list` probe when a name is missing, and commercial-surface closure for surface-registered servers. `registry-bridge.mapServer` already carries `tool_list` into the market catalog, which is what the detail view needs for a declared-versus-total display.

## Goals / Non-Goals

**Goals:**
- Make "no tool declaration" unrepresentable in a *published* version, while leaving already-published versions installable.
- Put tool-level closure where the manifest and the skill bodies are both available (publish), not in the runtime.
- Make the cost visible where the decision is made: the pack detail page.

**Non-Goals:**
- Rejecting undeclared references at *install* time — legacy versions must keep installing (the runtime treats absent as full surface).
- Deriving the declaration server-side; that is the authoring repo's job (`pack-tool-declaration-backfill`).
- Changing the runtime filter behavior (`full-mode-tool-scope`).

## Decisions

### D1 门放在 publish，不放 install

`installPack` 复跑同一份校验器。如果 `fullSurface` 之外的"无声明"在 shape 校验里被拒，那么存量已发布版本在安装时会被自己的校验器拒掉——用户会突然装不上已经买过的东西。所以：

- `validatePackManifest`（shape）**接受**"无声明"（向后兼容），只新增 `fullSurface`/`fullSurfaceReason` 的键合法化与互斥检查；
- **publish 路径**单独执行"必须有其一"的门，并在错误里给两种修法；
- install 路径继续按 shape 校验，不执行该门。

这条边界是本次最容易写错的地方，spec 里用"Legacy version renders as undeclared"和安装兼容性两条兜住。

替代方案：在 shape 校验里直接拒绝无声明。否决：会把存量版本变成不可安装。

### D2 工具级闭包在 publish 端用技能正文对拍

复用 `pack-server-closure` 已有的抽取器（`mcp__<server>__<tool>`）。闭包只对"声明了 allowTools"的引用生效；`fullSurface` 引用豁免。失败信息点名 server + tool + 引用它的技能，和既有 server 级闭包的文案结构一致。

为什么不在 shape 校验里做：shape 校验同时被 install 调用，而存量版本同样会违反这条闭包——必须在 publish 端。

### D3 `fullSurface` 与 `allowTools` 互斥

一个引用同时带两者是作者意图不明（到底要不要收窄？）。shape 层直接拒绝，错误点名冲突字段。

### D4 详情页从版本快照 + catalog `tool_list` 渲染，不发实时探测

详情页是浏览面，不能因为某个 server 暂时 401 就渲染失败。`tool_list` 已在 `registry-bridge.mapServer` 里进了 catalog，直接用于"声明 N / 全量 M"。`fullSurfaceReason` 从 manifest 读。旧版本（两者皆无）渲染为"全量（未声明）"，不报错。

### D5 编辑器：草稿可存，发布才拦

草稿允许"还没选工具"，否则作者中途保存就失败。编辑器在"未选工具"状态提供"标为全量 + 填理由"的显式按钮，并在发布前做一次本地预检（复用同一套规则），让作者在点发布前就看到缺口。

## Risks / Trade-offs

- [把门错放进 shape 校验 → 存量 pack 装不上] → D1 的边界 + 一条 install 兼容性测试：一份无声明的旧 manifest 必须仍能安装。
- [作者为绕过门全部标 `fullSurface`] → 理由必填 + 详情页展示；同时作者仓的构建报告会单列全量引用，形成社会压力而非硬拦。
- [工具级闭包误伤间接引用] → `fullSurface` 是显式逃生舱；错误信息点名技能，作者能立刻判断该补声明还是标全量。
- [详情页对旧版本渲染异常] → D4 的"未声明"分支 + 一条 fixture 测试。
- [与作者仓重发的时间差：门先上线，旧 pack 下次发版才被拦] → 这是有意为之；回填与重发在 `pack-tool-declaration-backfill` 里成批完成。

## Migration Plan

1. shape 校验器加 `fullSurface`/`fullSurfaceReason`（互斥、理由非空）——纯增量，旧 manifest 不受影响。
2. publish 端加"必须有其一"的门与工具级闭包；先以环境开关 `PACK_TOOL_FACE_GATE=warn` 上线，只记录不拒绝，观察一周的违规面。
3. 切到 `enforce`。
4. 详情页披露上线。
5. 回滚：开关回 `warn` 或 `off`；shape 层的新键对旧版本惰性。

## Open Questions

（无）
