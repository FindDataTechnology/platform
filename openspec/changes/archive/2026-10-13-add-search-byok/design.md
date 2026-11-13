# Design: add-search-byok

## Context

见 proposal.md。已核实的落点：

- **每类凭据一张表**是本仓既定模式（`user_registry_credentials` v15、`user_connector_credentials` v23，v23 注释明写"独立生命周期，合表要迁移零收益"）→ 用户搜索 key 用新表 v27 同款形状。
- **凭据到 cell 的通道**：`platform.bundle.json` 的 websearch 行声明 `envRefs`，`dsh-profile.js` 在写 patch 时解析注入（scoped 派生 token 走的就是这条）。用户 key 是**用户自有凭据**，不是平台秘密——按威胁模型直接进该用户自己的 cell patch，与 registry key 同级，不做派生。
- **relay 的 key 使用点**：`serpapiSearch(key, query, num)` 单 key 单次调用；`poolSearch` 做轮询+冷却。覆盖 key 只需在 poolSearch 前插一层"有覆盖先用覆盖"。
- **面板已有骨架**（add-websearch-settings）：`WebSearchSection.tsx` + `websearch-api.ts` + 三路由。本变更把它从"管理员单区"扩成"用户区+管理区"。

## Goals / Non-Goals

**Goals**：用户自带 key 即刻生效、失败自动回退共享池、来源对 agent 与用户都可见、共享池健康对管理员可见。

**Non-Goals**：不做按用户计量/计费（那是 metering 面）；不做多上游提供商选择（GLM 仍预留未实现）；不做 relay 侧用户注册（用户 key 完全请求级，relay 无状态记忆，唯一记忆是内存冷却表）。

## Decisions

### D1 存储：新表 `user_search_credentials`（迁移 v27）

`email TEXT PRIMARY KEY, token TEXT NOT NULL, updated_at TEXT NOT NULL`——与 connector 凭据同款。存取层放 `lib/websearch-relay.js`（`getUserKey(email)` / `setUserKey(email, token)` / `clearUserKey(email)`），owner key 归一复用 `registry-credentials.ownerKey` 的同一规则（auth 关 = 机器属主单槽）。

### D2 传输：`X-Serpapi-Key` 请求头

- `platform.bundle.json` 的 websearch envRefs 追加 `SEARCH_USER_KEY`，并声明 `envRefsOptional: ["SEARCH_USER_KEY"]`（未配=正常态，不产生降级警告；既有 envRefs 的警告语义不变）。
- `dsh-profile.js` 的 `relayEnvOverrides(ownerEmail)` 读该用户存储 key，存在则加 `SEARCH_USER_KEY` 进 overrides（用户自有凭据，不做 scoped 派生——派生只针对平台共享秘密）。
- `server/websearch-mcp.js`：env 有 `SEARCH_USER_KEY` 时在 `/v1/search` 请求带 `X-Serpapi-Key` 头；并把响应的 `x-search-source` 映射进工具结果（`{results, source}`，additive）。

### D3 relay 回退链（同一请求内）

```
auth（relay token/scoped）通过
  → 若 X-Serpapi-Key 在场且未冷却：
      用它调 serpapi
        成功 → x-search-source: user
        失败 → 记该 key 哈希冷却；落共享池（x-search-source: pool-after-user-failure）
  → 否则/回退后：poolSearch（现状轮询+冷却）
      成功 → x-search-source: pool
      全挂 → 503（错误文案区分"含用户 key 均失败"）
```

- 覆盖 key 冷却表：内存 Map，key 用 `sha256(key)` 前 8 hex 归因；耗尽类失败 12h、瞬时类 60s（与池同语义）。**日志只出现哈希前缀**，永不落 key 值。
- 每日上限（DAILY_CAP）对**所有**搜索计数不变（防滥用，与 key 来源无关）——用户自有配额另算在 serpapi 侧。
- stats 增列：`overrides: { used, failed, fallback }`（仅计数）。

### D4 来源可见

- relay 响应头 `x-search-source: user|pool|pool-after-user-failure`。
- websearch-mcp 把 source 放进工具结果；agent 可据此对用户说明"用的是你的密钥/共享池"。
- 面板测试按钮：请求带当前表单/存储的 user key，返回里含 relay 的 source（200 时），面板渲染"连接正常——使用我的密钥 / 使用共享池（你的密钥失败已回退）"。

### D5 路由与门

- `GET/PUT /api/config/websearch/userkey`：**任意登录用户**（自己只能读写自己的；email 取自请求身份，不接受客户端指定）。PUT 三态同既有语义（缺=不动/空=清除/值=保存+热重写 patch）。GET 只回 `hasKey` + `maskToken()`。
- `GET /api/config/websearch/pool`：**管理员门**，服务端用生效 relay 凭据代理 `/v1/stats`，返回 `{keys: [{index, coolingDown, failures}], poolDry, upstreamErrors, dailyCap, day}`——secret-free（relay 侧本就只回前缀/索引）。
- 既有 `GET/PUT /api/config/websearch`（url/token）与 `/test` 保持管理员门；`/test` 增可选 `userKey` 入参（未给则用调用者存储值）。

### D6 面板：双区

- 分区从 `adminOnly` 改**全员可见**（sections.ts 去掉 adminOnly）；组件内用 `useAuth()`（groups ∩ adminGroups）判定管理区渲染。
- 区一「我的搜索密钥」（所有用户）：输入（write-only）+ 保存/清除 + 测试（显示来源结论）。
- 区二「共享搜索服务」（管理员）：既有 url/token 字段 + 池状态（key 数/冷却/池干涸计数/当日用量）。

## Risks / Trade-offs

- **用户 key 进该用户 cell patch**：与 registry/connector 凭据同级暴露面（用户自有凭据在自己 cell），威胁模型内；不派生是因为派生只保护**平台共享**秘密。
- **回退语义可能掩盖用户 key 失效**：用 `pool-after-user-failure` 三态而非二态暴露，agent/面板都能说明白；不静默。
- **relay 无状态记忆**：覆盖 key 冷却只在单进程内存（relay 单副本），滚动后重置——可接受（下次请求重新试一次用户 key，最坏多一次失败往返）。
- **DAILY_CAP 仍计所有请求**：用户自带 key 也可能撞 300/日上限。属防滥用设计取舍，文案在 429 里已明示；若未来 BYOK 上量再拆计数维度。
