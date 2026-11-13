# Proposal: add-search-byok

## Why

搜索能力目前只有一层凭据：部署级 relay 令牌（+ relay 侧共享 serpapi 池）。这挡住了两类正当需求：用户想用自己的搜索 key（自带 key、自担配额、不挤占共享池），而没配 key 的用户应该照常吃 admin 维护的共享池。当前模型两者都表达不了——要么全体共享（现状），要么没有 BYOK。

## What Changes

- **用户级搜索密钥（BYOK）**：设置 → 网络搜索 对**所有用户**可见，新增「我的搜索密钥」区：用户粘贴自己的 SerpAPI key（write-only，只回尾 4 位掩码），保存即生效；清除即回退共享池。用户 key 只影响该用户自己的搜索。
- **relay 请求级 key 覆盖**：websearch-mcp 在调用时带 `X-Serpapi-Key` 头（值来自 cell 注入的用户 key）。relay 校验通过后：**用户 key 优先**；用户 key 失败（配额/鉴权/限流）→ **自动回退共享池**并如实标注来源；两者都挂才 503。
- **来源可见**：搜索响应携带 `x-search-source: user|pool`，agent 的 web_search 结果里体现来源；设置面板显示"当前使用：我的密钥 / 共享池"。
- **池状态只读端点**：管理员可见共享池健康（key 数、冷却中、当日用量），面板上直接看到"共享池干涸"而不是黑盒 503。
- **管理区对非管理员只读/隐藏**：面板分两区——「我的搜索密钥」（所有用户可写）与「共享搜索服务」（管理员才见/可写）。

## Capabilities

### New Capabilities

（无——并入既有 capability。）

### Modified Capabilities

- `web-search`: 新增 BYOK 需求组——用户级密钥的读写语义（write-only、掩码、清除回退）、请求级覆盖与回退链（用户 key → 共享池 → 503）、来源标注、池状态只读端点、面板可见性规则（用户区全可见、管理区 admin）。
- `scoped-relay-credentials`: relay 鉴权之外新增请求级上游 key 覆盖：覆盖 key 的校验/冷却/回退语义与共享池并列且独立，覆盖 key 永不落日志（哈希归因）。

## Impact

- relay：`services/search-relay/index.js`（请求头解析、覆盖 key 的冷却表、回退链、来源头、stats 增列）+ 单测。
- 平台：`server/routes/misc.js`（userKey GET/PUT、test 带 userKey、池状态代理端点）、`lib/websearch-relay.js`（用户凭据存取 + 掩码）、`dsh-profile.js`（envRefs 注入用户 key，未配则不注入不告警）、`platform.bundle.json`（websearch 增 `SEARCH_USER_KEY` envRef）、`server/websearch-mcp.js`（发 `X-Serpapi-Key` 头）。
- 前端：`WebSearchSection.tsx` 双区重构 + `websearch-api.ts` + 五语 locale。
- 部署：relay GitOps 再生（内嵌代码更新）；platform 出片+滚。用户 key 存 `deployment_config`（键 `searchUserKey:<email>`，与 registry 凭据同库同密级）。
- 不改 registry、不改 dsh 镜像。
