## Context

See `proposal.md` — Why. The composition pipeline (`dsh-profile.js` `writeMcpPatch`) merges `mcp.json` + DB `extension_configs`, resolves credential refs, applies the availability overlay, then the focus layer (drops servers not in the selected role's keep-set), then `writeToolFilterPatch(...)` materializes `tool-filter.json` beside `platform-tool-scope.js`. That bridge already enforces a filter in **every** mode — guard, register-shadow, and composition-time restrict — so the missing piece is purely the input: today only `scope.source === "pack"` supplies a filter map; every other branch writes `null`. `deriveScope` returns `mcpTools: null` for both full mode and custom presets. The focus overlay is stored as one preference key per preset (`focus.overlay.<presetId>`) holding add/remove lists, read at every composition.

## Goals / Non-Goals

**Goals:**
- Full mode stops mounting the entire surface of servers that packs brought in.
- No new persisted "materialized allowlist" state — derive at every composition, like the existing focus derivation.
- A per-server escape hatch that is global (not per-preset), so a user who wants the whole surface gets it in every mode.
- Backward compatibility during the backfill window: an undeclared pack reference must never narrow to an empty set.

**Non-Goals:**
- Changing focused-mode semantics (it already narrows; only the override precedence is new).
- Changing the bridge's execution logic (`platform-tool-scope.js` guard/restrict/register-shadow behavior is untouched). The ONE bridge edit is the denial copy gaining a Settings → MCP pointer — product-approved, and covered by a unit assertion.
- Touching the operator baseline (`mcp.json`) or bundled servers — they are never pack-referenced by construction.
- Deferred tool registration / progressive disclosure (a separate architectural question).
- Registry-side virtual endpoints per pack (rejected in `add-mcp-tool-scoping` D1).

## Decisions

### D1 并集来源 = `installed_packs` 的 manifest 快照，不引入 origin 列

`installMcpRef` 目前调用 `addMcpServer` 时不记 origin，落库统一是 `user`，无法区分"pack 带进来的"和"用户自己装的"。本 change 不补这一列：并集只需要"某个 server 被哪些已装 pack 引用"，这从 `installed_packs.manifest` 直接可算。

规则：`server → union(该 server 在每份已装 manifest 里的 effective allowTools)`。

替代方案：给 `extension_configs` 加 `origin=pack`。否决：要迁移；且同一 server 可能既被 pack 引用又被用户手动安装，origin 无法表达"按并集过滤"这个语义。

### D2 未声明 = 全量（过渡期的安全阀）

并集计算时，任一引用满足下列之一，该 server 的并集结果就是"全量"（即不产生过滤项）：
- 引用没有 `allowTools`；
- 引用标了 `fullSurface: true`；
- manifest 来自本 change 之前的版本。

这条规则让"回填尚未完成"和"显式全量"收敛到同一个安全行为：**绝不因为缺声明而把工具面清空**。没有这条，一个旧 pack 装上去就会让 `fd-daas-mcp` 的 161 个工具全部消失。

### D3 覆盖标记存 `user_preferences`，一个键

键：`toolScope.fullSurface`，值：server 名字的 JSON 数组。复用现有 `getPreference` / `setPreference`（原子 upsert），空数组即删除键。

为什么不放 `extension_configs.permissions`：那一列是给扩展工具的 allow/deny 用的，语义是"这个扩展能调用哪些内置工具"，不是"这个 MCP server 暴露哪些工具"，混用会让两个概念互相污染。

为什么不放 focus overlay：overlay 是 per-preset 的（`focus.overlay.<presetId>`），而覆盖是全局偏好——用户在 full 模式打开宽面，切到聚焦角色也应该继续生效（spec 的 override 要求就是这样写的）。

### D4 自建预设的 `mcpTools` 落在 `user_presets.mcp_tools`

新增列 `mcp_tools TEXT DEFAULT '{}'`（JSON：`{server: [leaf...]}`），与既有 `mcp_servers` 并列。`deriveScope` 的 custom 分支读它；缺省（空对象）时回落到 D1 的并集，而不是 `null`。

校验：编辑器从 catalog 的 `tool_list` 提供服务端工具清单，自由输入被拒（与 pack 编辑器同一套 UI 契约）。

### D5 过滤器文档形状不变

继续写 `{ "mcpTools": { "<server>": ["leaf", ...] } }`。`platform-tool-scope.js` 已经按这个形状读取，且每个 cell 一次只合成一个 scope，不需要 `byPreset` 分段（那是 pod adapter 多角色共进程时用的）。

### D6 优先级

```
用户覆盖 (fullSurface)  >  聚焦 pack 的 allowTools  >  full 模式的并集  >  不过滤
```

覆盖在 `deriveScope` 之后、写 filter 之前应用：从映射里删除被覆盖的 server 键，等价于"该 server 无过滤"。

### D7 只在合成时刻重算

并集在每次 `writeMcpPatch` 时从 DB 读 `installed_packs` 计算，不缓存、不落盘为独立状态。合成时机与现有 focus 推导完全一致（启动、切预设、MCP/skill 配置变化），所以不存在"并集过期"的窗口。

### D8 环境开关做灰度

`FULL_MODE_TOOL_SCOPE=off` 时 `writeToolFilterPatch(null)`，行为与今天逐字节一致。默认值在回填完成后翻转为 `on`。这样 paas 可以先发版、后开闸。

## Risks / Trade-offs

- [并集算出空集 → 工具面全被藏] → D2 的"未声明即全量" + 一条单测：`[{allowTools: undefined}]` 必须产出"不过滤"，绝不能产出 `{server: []}`。
- [用户装了一个 pack 后，日常对话里少了一批工具而不自知] → 设置→MCP 的覆盖开关 + pack 详情页显示"声明 N / 全量 M"；`tool_search` 的拒绝理由文案已存在，能指向开关。
- [并集随装包变化，导致 prompt cache 失效] → 只在合成时刻变化（不是每轮），且现有切换预设本来就会重建 runtime；可接受。
- [pod adapter 的多角色共进程：顶层并集是进程级上界] → 与既有 `byPreset` 语义一致：顶层 map 是 guard/register-shadow 的上界，per-preset 段负责收窄；full 模式的并集天然是上界，不会误拦任何角色。
- [覆盖标记指向一个已卸载的 server] → 悬空键惰性无害（合成时没有该 server 就不参与），沿用 overlay 的"悬空项不报错"纪律。

## Migration Plan

1. 实现并集推导 + 覆盖存储 + 自定义预设列，默认 `FULL_MODE_TOOL_SCOPE=off`（行为不变）。
2. 单测覆盖 D2 的三种"全量"输入与 D6 的优先级。
3. 依赖 finddata 侧回填完成后，在 fd-prod 打开开关，用 `scripts/probe-pack-scope.mjs` 对比 full 模式 roster 与 `--turn-trace` token 差。
4. 观察一周后把默认值翻转为 on。

回滚：开关置 off 即回到 `writeToolFilterPatch(null)`，无需回滚代码；覆盖标记与 `mcp_tools` 列对旧版本是惰性数据。

## Open Questions

（无——实现细节均已定；`byPreset` 的多角色场景沿用既有形状，不需要新决策。）
