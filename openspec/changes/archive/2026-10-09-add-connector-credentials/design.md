## Context

See proposal.md - Why. 设计受三件已存在的事实约束：

1. **`credentialRef` 机制已成熟**（`registry-credentials` 能力 + `dsh-profile.js` 的 `writeMcpPatch`）：安装时打标、profile 写入时解析、解析失败省略服务。它当前把 ref 名硬编码为 `"registry"` 单一值，解析循环也只认这一个。
2. **凭据按用户键控**：hosted 模式键=登录邮箱，auth off 键=machine-owner；表在 cell 的 SQLite（`db.js` 迁移序列管理 schema）。
3. **connector 已上线**：`https://connector.finddatatech.cloud/mcp`，认证是 `Authorization: Bearer oct_…`（user_pat），无过期时间（PAT 由用户主动撤销）。

## Goals / Non-Goals

**Goals:**

- connector PAT 复用 `credentialRef` 全链路：存储、注入、解析失败省略、热生效，零新增注入路径。
- ref 解析按名分派，使第三种 ref（未来）只需注册一个解析器。
- 用户能在设置面自助完成粘贴/查看/断开。
- PAT 失效（用户撤销、粘贴后又被撤销）在会话里以 401 暴露时自动翻面：卡片显示已失效、服务从有效 profile 省略，恰好一次重应用。

**Non-Goals:**

- 不引入 PAT 过期语义（connector PAT 无 exp，投影无 `expiresAt`；失效由 401 驱动并自动翻面，见 D7，但不做过期预判与续期提醒）。
- 不做 OAuth 自动换取 PAT（connector 的登录是浏览器重定向 + 铸造，自动化留待后续 change）。
- 不改 connector 侧任何代码。

## Decisions

### D1: 泛化 `credentialRef` 为注册表分派，而不是并列第二个专用分支

`registry-credentials.js` 现在把 ref 名当常量导出。方案：新增 `credential-refs.js`（或就地扩展）维护 `refName → { isRef(config), liveToken(email), status(email), store/disconnect }` 的注册表，`dsh-profile.js` 的解析循环按 `config.credentialRef` 查表。

**理由**：注入路径只有一条（profile 写入），如果按 ref 名复制分支，第三个 ref 会再复制一次；查表让新增 ref 只注册不改编排。**替代方案**：在 `dsh-profile.js` 里写 `if ref === "connector"` 的并列分支——最小改动，但把 ref 名清单散进编排代码，且"解析失败省略"的逻辑会分叉。

### D2: connector 凭据单独建表，不并入 registry 凭据表

新表 `user_connector_credentials`（email/owner key + token + updated_at），与 `user_registry_credentials` 同形但独立。

**理由**：两凭据生命周期完全独立（一个可同时连接两边，断开一边不影响另一边）；并表会把"两个可选 token"塞进一行，状态投影和断开语义都要加参数。**替代方案**：`user_credentials(email, kind, token, …)` 通用表——更"干净"，但需要迁移现有 registry 行（数据迁移风险）且让 registry 路径的既有测试全部改写，收益不抵风险。

### D3: 服务行进 `mcp.json`（部署基线），不自动播种到 DB

connector MCP 服务行作为 `mcp.json` 的一个条目随镜像走：`{ url: "https://connector.finddatatech.cloud/mcp", credentialRef: "connector" }`，服务名定为 `connector`（工具名即 `mcp__connector__list_connections`；与既有 library/cron/delegation 无冲突）。

**理由**：与既有"operator config 基线 + DB 覆盖"分层一致；未连接 PAT 的用户因解析失败而看不到它，无需按用户播种 DB 行。**替代方案**：启动时 seed 进 DB（像 bundled 服务）——会让它出现在扩展管理列表里可被用户误删，且需要处理"已有旧行"的幂等。

**行可见性的三个角落（2026-10-09 grill 定案）**：① 该行随镜像进开源快照仓，`connector.finddatatech.cloud` 硬编码进 OSS 基线——保留（对 OSS 用户它是指向萬星生态的漏斗；无 PAT 即惰性，仅一条 warning 噪声）。② 自托管者可静默它：DB 加同名 `connector` 行并 `enabled: false`（既有"DB disabled 落条目"机制）。③ 生产 runner 同镜像带此行，每服务 profile 写一条省略 warning——接受。

### D4: 状态投影给 connected/updatedAt/stale，无 expiresAt

registry 凭据有 JWT exp 可解析；connector PAT 是 `oct_` 不透明串，无 exp。投影字段因此是 `connected` / `updatedAt` / `stale`（401 翻面标记，见 D7），UI 不显示过期倒计时；`stale` 字段名与 registry 投影对齐，UI 文案用「已失效，请重新粘贴」。

**理由**：不编造不存在的语义；失效由 401 暴露并自动标记（D7），预判式过期提醒不做。

### D5: 面板入口放扩展/MCP 市场附近，复用 `RegistryConnectPanel` 的交互形状

新 `ConnectorConnectPanel`：未连接时给粘贴框 + "PAT 从 connector 的「我的连接」页面获取"指引；已连接显示状态与断开按钮。挂载点与 `RegistryConnectPanel` 相同（`McpServerForm` / `McpMarketView`）。

**理由**：用户的同一心智模型（"我要给 MCP 服务配凭据"），放一起最省解释成本。**替代方案**：独立设置页——更"产品化"，但把同一件事拆到两处，且需要新的导航项与 i18n 面。

### D6: 粘贴时双重校验——`oct_` 前缀 + 一次 MCP initialize 探活

POST 粘贴端点先验形状（非 `oct_` 前缀 → 400「不是 connector PAT」），再对 connector MCP 入口发一次 initialize（`Authorization: Bearer <PAT>`）：401 → 400 拒收（「token 已失效或错误」）；网络错/5xx → 照存不拦（connector 故障不阻断录入）。探活 URL 不二次硬编码——取 `mcp.json` connector 行的 `url`（单一事实源）；行缺席则跳过探活只做前缀校验。

**理由**：粘贴是用户唯一录入点，探活把两类最常见失败（粘错串、已撤销）当场变成可理解报错；401 语义无歧义。**替代方案**：沿 registry 现状零校验——失败延迟到首次工具调用，用户无从自查。

### D7: 401 失效翻面进 v1——泛化 dsh-events 既有链路，而非新造

`server/dsh-events.js` 已有 registry 的 401→markStale→重应用机制（正则 `\b401\b|unauthoriz` 命中 `mcp__<server>__<tool>` 报错文本）。本次把它泛化：按 ref 注册表分派（`markInvalid(email)`），并补上 lookup 盲区——现只查 DB 行，须加 mcp.json 行的查表。connector 401 → 行打 `stale` 标记、广播凭据失效事件、立即重应用 profile 省略服务；沿用 registry 的「false ⇒ 已 stale 则不再重复重应用」幂等，一轮 401 恰好一次重应用。重粘 PAT 即恢复（store 覆盖并清标记）。

**理由**：机制现成、增量几十行；不做的话 PAT 撤销后卡片永远「已连接」而工具永远 401，是最难自查的失败模式。**替代方案**：v1 严格不标记（design 初稿 Non-Goal）——被 grill 推翻，理由是 scope 而非原则。残余风险：401 检测靠报错文本正则，connector 工具的 401 文案须真回合实证命中（任务 3.3 顺带）。

### D8: `credentialRef` 是系统管理字段——客户端提交一律 400 拒收

POST/PUT `/api/extensions/mcp` 收到的 config 若携带 `credentialRef` → 400「credentialRef 由系统管理」。合法打标来源仅两处：市场目录安装（服务端为 registry-origin 盖 `registry`）与 operator 层 `mcp.json`。

**理由**：泛化后 ref 值域变宽，手输 ref 打开"把用户自己凭据发往任意 URL"的自钓角与手误角；剥离责任比剥离数据干净——显式 400 优于静默剥字段。自建 connector 实例的 operator 仍可编辑 `mcp.json`（本就是正确通道）。registry 现状同样收口（行为收紧，非破坏：合法路径不受影响）。

### D9: overlay 可见宇宙同步泛化——带 ref 的行一律按凭据存活过滤

`server/routes/overlay.js` 的 `availableMcpNames`（聚焦角色"可加资源"宇宙）现对 DB 行做 registry 凭据过滤、对 mcp.json 名单无条件放入。connector 行是首个带 ref 的 mcp.json 行：未连接用户会在可加清单看到 `connector`，加进预设后实际又被省略。改为：带 `credentialRef` 的行（不论 mcp.json 还是 DB）按 ref 注册表对当前身份的凭据存活过滤，与 `writeMcpPatch` 语义对齐。

**理由**：可见宇宙与有效 profile 的凭据过滤语义必须同源，否则出现"可加但加了白加"的清单项。基线不受影响——聚焦角色保基线是定义行为，不经可加清单。

## Risks / Trade-offs

- **[注册表引入间接层，registry 路径有回归风险]** → registry 的解析结果必须逐字节不变；实现时保留 `registry-credentials.js` 的导出面，注册表只是转发，并用既有 e2e（`registry-connect.spec.js`）作回归门。
- **[PAT 明文入 SQLite]** → 与 registry 凭据同级风险（本机/集群内可信存储），且响应面只写不读；如未来要求加密，两表一起加（`llm-providers` 已有加密先例可循）。
- **[mcp.json 的 connector 行对所有部署可见]** → 无凭据即恒被省略（一条 warning）；自托管静默法与 runner 噪声接受见 D3。
- **[401 文本正则是启发式]** → 检测依赖工具报错文本含 `401`/`unauthorized`；connector 工具的 401 文案在任务 3.3 真回合实证，未命中则补 connector 报错面适配（兜底仍省略服务、重粘即恢复）。
- **[探活引入粘贴时的外联依赖]** → 仅 401 拒收，网络错照存（D6）；connector 不可达时录入不阻断。

## Migration Plan

1. 迁移新增 `user_connector_credentials` 表（纯新增，无既有数据改动；回滚=删表，无数据损失）。
2. `mcp.json` 新增 connector 服务行；若解析器未就绪，该行会被既有逻辑忽略（`credentialRef` 无人认领时服务被省略）——部署顺序安全。
3. 上线后验证：未连接用户 profile 无 connector 服务；粘贴 PAT 后 dsh 会话出现 `mcp__connector__*` 工具并能列出用户在 connector 里的连接。
4. 回滚：撤镜像 tag；表留着无副作用。

## Open Questions

（无。初稿遗留的「服务名」已定 `connector`（D3）；2026-10-09 grill 九问全按推荐定案——401 翻面进 v1（D7）、overlay 同步泛化（D9）、粘贴双重校验（D6）、路由镜像形、OSS 行保留（D3）、手输 ref 拒收（D8）、未知 ref 名入规格、词汇表两词条。）
