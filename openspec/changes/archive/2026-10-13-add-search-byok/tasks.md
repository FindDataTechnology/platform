# Tasks: add-search-byok

## 1. Relay：请求级覆盖 + 回退链（services/search-relay/index.js）

- [x] 1.1 解析 `X-Serpapi-Key` 头（缺失=零变化）；覆盖 key 冷却表（sha256 前 8 hex 归因，耗尽 12h/瞬时 60s）
- [x] 1.2 回退链：覆盖可用先用 → 失败落共享池 → 双失败 503（文案区分）；响应头 `x-search-source`（user/pool/pool-after-user-failure）
- [x] 1.3 stats 增 `overrides: {used, failed, fallback}`（仅计数）；日志只出现哈希前缀
- [x] 1.4 单测：无头零变化 / 覆盖优先 / 覆盖失败回退 / 双失败 503 / 日志不含 key / 401+429 不受覆盖影响

## 2. 平台：存储 + 通道 + 路由（db.js · lib/websearch-relay.js · dsh-profile.js · routes/misc.js · websearch-mcp.js）

- [x] 2.1 迁移 v27 新表 `user_search_credentials`（email PK, token, updated_at）+ db 存取函数（get/set/delete，owner key 归一复用）
- [x] 2.2 `lib/websearch-relay.js`：`getUserKey/setUserKey/clearUserKey` + `maskToken` 复用
- [x] 2.3 `platform.bundle.json`：websearch envRefs 追加 `SEARCH_USER_KEY` + `envRefsOptional` 声明；`dsh-profile.js` 的 `relayEnvOverrides` 注入用户 key（未配不注入不警告）；`toMcpClientEntry` 支持 optional 语义
- [x] 2.4 `server/websearch-mcp.js`：有 `SEARCH_USER_KEY` 时带 `X-Serpapi-Key` 头；响应 `x-search-source` 透出到工具结果（additive）
- [x] 2.5 路由：`GET/PUT /api/config/websearch/userkey`（任意登录用户、只能自己）+ `GET /api/config/websearch/pool`（admin 门，代理 relay stats）；`/test` 增可选 userKey 并用之

## 3. 前端：面板双区（web/src/）

- [x] 3.1 `sections.ts` 去 `adminOnly`（分区全员可见）；`WebSearchSection` 重构：用户区（我的搜索密钥）+ 管理区（共享服务+池状态，按 useAuth 判定渲染）
- [x] 3.2 `websearch-api.ts` 增 userkey/pool 封装；测试结论渲染来源（user/pool/pool-after-user-failure）
- [x] 3.3 五语 locale 全套新增文案；`check:locales` 过

## 4. 测试与回归

- [x] 4.1 `scripts/test-search-byok.mjs`：用户 key 存取/掩码/owner 隔离、路由门（用户写自己/管理员 pool 403 边界）、dsh-profile 注入（有/无 key 两态）、test 带 userKey
- [x] 4.2 全量 `test:unit` 零回归 + `check:locales` + web 构建

## 5. 上线与验收

- [x] 5.1 relay 代码进 GitOps ConfigMap 再生 + 滚；platform 出片（scs001 线）→ ccr → 滚
- [x] 5.2 生产实证：无 user key 走池（现状不变）；配假 user key → 搜索回退共享池且来源=pool-after-user-failure；清 key 回退；池状态端点（admin）；非管理员 userkey 端点可写而 pool 端点 403
- [x] 5.3 归档（validate + archive）+ 记忆更新
