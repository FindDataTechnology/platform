# fix-virtual-scope-semantics

## Why

线上唯一虚拟 MCP 服务器 `/virtual/lex-legal`（识律线对外统一入口）对一切真实客户凭据不可用：`virtual_router.lua` 对 server 级 `required_scopes` 用 AND 语义（全部满足），而授权模型（`mcp_scopes_default.server_access`）是 either-or（任一 scope 即授予入口）。所有真实凭据（lex 客户只有 `mcp-lex-execute`、law-bench 用户只有 `mcp-law-bench-execute`）被 validate 放行后在 lua 二道门拒绝，错误响应（HTTP 200 + JSON-RPC error）在排障中被误读为"聚合层返回空"。2026-10-06 排障定案：聚合层全链健康（双 scope 凭据实测 tools/list 10 工具 + wenshu_search 2 条真实结果），唯一的病根就是这道门的语义。

## What Changes

- `docker/lua/virtual_router.lua`：新增 `_has_any_scope` 谓词（server 级 `required_scopes` 任一满足即过），替换全部 6 处 server 级 `_has_scopes`（AND）调用点：`_handle_tools_list`、`_handle_tools_call`、route() 中 resources/list、resources/read、prompts/list、prompts/get 分支
- per-tool scope 检查（tools/call 内逐工具检查 + tools/list 的 scope 过滤）**保持 AND 不变**
- scope 拒绝时增加 `ngx.WARN` 日志（server_id + 所需 scope 列表）——消除"静默拒绝被误诊"的排障盲区
- `registry/schemas/virtual_server_models.py`：`required_scopes` Field 描述改为 "Scopes that grant access (any one suffices)"（API/OpenAPI 自文档）
- `tests/lua/test_virtual_router.lua`：新增回归用例（多 scope required_scopes + 单 scope 用户放行/无 scope 拒绝/per-tool AND 保形）
- `.github/workflows/image.yml`：`BUILD_VERSION` fd-1.1.1 → fd-1.1.2（一个发布一个版本）

### Non-goals

- business-mcp 的 8 个法律工具未进 `tool_mappings`（交接文档"聚合两个后端"与实物不符，现网为单后端终态；如需暴露属新需求）
- 前端表单文案（placeholder 本身中性，无 AND/OR 断言）
- flush_metrics DNS 噪音刷 error.log、auth-server "Legacy scope audit" 4 警告（独立旧账）
- 不改任何生产数据：`/virtual/lex-legal` 的 `required_scopes` 保持双 scope，OR 语义下两者均为有效入口 scope

## Capabilities

### New Capabilities
- `virtual-mcp-servers`: registry 虚拟 MCP 服务器的聚合路由行为契约——server 级 scope 门（any-of）、per-tool scope 门（all-of）、scope 拒绝的可观测性

### Modified Capabilities

（无——`virtual-mcp-servers` 为新建能力，现网无对应 spec）

## Impact

- 代码仓：`mcp-gateway-registry`（github/gitee `FindDataTechnology/mcp-gateway-registry`），载体分支从 **github main**（`c4b0994`，即线上 fd-1.1.1）切出——交接文档"提交 fd-1.0.0"按过时指令处理（fd-1.0.0 落后线上 12 提交；fd-i18n-ui 带 2 个未发布提交不混入）
- 生产行为变化：持有任一 `required_scopes` 的凭据从"被拒"变为"放行"（语义放宽）。现网仅 lex-legal 一个虚拟服务器，受影响面=lex 客户（解锁）+law-bench 用户（解锁）；无凭据/wire-only 仍被 validate 403 拒（已实证，不变）
- 发布线：push github main → GHA image.yml（matrix 会同时构建 auth-server 镜像，但 cheap-1 **只滚 registry 服务** pin，auth-server `sha-676a245`、mcpgw 不碰——遵守并行 wire 会话纪律）；回滚锚=现行 `sha-c4b0994` repin + `up -d --no-deps --no-build`
- 验收：wgk- 客户 key 全链（initialize → tools/list 10 工具 → wenshu_search(title_query=买卖合同) ≥2 条真实结果）；双 scope admin JWT 仍通；wire-only 仍 403；无凭据仍 401
