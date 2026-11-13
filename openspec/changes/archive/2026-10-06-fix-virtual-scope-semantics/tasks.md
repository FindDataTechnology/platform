# tasks — fix-virtual-scope-semantics

## 1. 本地实现（mcp-gateway-registry 仓）

- [x] 1.1 从 origin/main 切 `fix/virtual-scope-semantics` 分支（基线=c4b0994=线上 fd-1.1.1；验证：`git log --oneline -1` 与线上 pin sha 一致）※ 独立 worktree `/Users/chengsishi/code/mcp-gateway-registry-fixscope`，主树留在 fd-i18n-ui 不动
- [x] 1.2 `docker/lua/virtual_router.lua`：新增 `_has_any_scope` 谓词；替换 6 处 server 级 `_has_scopes`（_handle_tools_list / _handle_tools_call / route() 的 resources/list、resources/read、prompts/list、prompts/get）；拒绝处加 `ngx.WARN`（server_id + required 列表 + 用户 scope 数）；per-tool 两处 `_has_scopes` 保持不动（验证：`grep -n "_has_scopes\|_has_any_scope"` 调用点分工与 design D1/D2 一致）
- [x] 1.3 `tests/lua/test_virtual_router.lua` 新增用例：required={A,B}+仅 A 放行（回归本体）/ A、B 全无拒绝 / per-tool {A,B}+仅 A 该工具被过滤 / required=nil 放行（验证：`docker run --rm -v "$PWD":/app -w /app openresty/openresty:alpine resty tests/lua/test_virtual_router.lua` 全绿，改动前先跑一遍基线）※ 基线与改后均在 cheap3 openresty:jammy 容器跑（alpine resty 缺 perl；本地无 docker），新增 7 断言 + 原有全绿
- [x] 1.4 `registry/schemas/virtual_server_models.py`：server 级 `required_scopes` Field 描述改 "Scopes that grant access (any one suffices)"；`ToolScopeOverride` 描述补 "All these scopes are needed"（验证：grep 确认 5 处 Field 描述语义分流）
- [x] 1.5 `.github/workflows/image.yml`：`BUILD_VERSION=fd-1.1.1` → `fd-1.1.2`（验证：`grep -n BUILD_VERSION .github/workflows/image.yml`）
- [x] 1.6 回归：`pytest tests/unit/core/test_nginx_service.py` 全绿（mapping 生成器未动，纯确认无意外回归）※ 118 passed（coverage 门槛报错为单文件运行产物，非回归）

## 2. 发布（标准镜像线）

- [x] 2.1 单 commit（lua+单测+schema+版本 bump，中文长信息循仓库惯例）推 `origin fix/virtual-scope-semantics` 留档，再 `git push origin HEAD:main` 触发 GHA image.yml（验证：GHA Actions 页 matrix 两镜像 build-push 成功，产出新 sha tag）※ commit=48748992（英文长信息循本仓惯例），GHA run 37380369449 双镜像 success，tag=**sha-4874899**（7 位短 sha 惯例）
- [x] 2.2 确认镜像到 ccr：cheap-3 relay cron */5 同步后，TCR 仓库出现新 tag（验证：cheap-1 `docker pull ccr.ccs.tencentyun.com/yizuo/mcp-registry:<新sha>` 成功）※ relay 06:20 同步 OK；cheap-1 pull 成功；镜像内容预检 _has_any_scope 在位
- [x] 2.3 **等用户 go**（与并行 wire 会话对齐窗口）→ cheap-1 `/opt/mcp-gateway-registry/docker-compose.prebuilt.yml` 仅改 registry 服务 pin 为新 sha，`docker compose -p mcp-gateway-registry up -d --no-deps --no-build registry`（验证：`docker ps` registry 容器新镜像、auth-server/mcpgw 未动；diff 确认 compose 只变了 registry image 行）※ 用户 2026-10-06 放行；pin `sha-c4b0994→sha-4874899`（备份 `.bak-*` 在案，diff 单行）；**坑：必须带 `-f docker-compose.prebuilt.yml`**（目录里 docker-compose.yml 带 build 段会解析成 `:latest`）；游后 registry Up healthy、auth/mcpgw Up 9h 未动、/api/version=fd-1.1.2、启动日志 "Wrote 1 virtual server mapping files"、运行容器内 lua 9 处新符号/6 处 server 门/2 处 per-tool AND 全在位

## 3. 验收与收尾

- [x] 3.1 验收矩阵（cheap-1 上 curl 网关 127.0.0.1:18080 带 Host 头）：wgk- key 全链 initialize→tools/list 10 工具→wenshu_search(title_query=买卖合同) ≥2 条真实结果；双 scope admin JWT 仍通；wire-only JWT 仍 403；无凭据仍 401（验证：四向探针输出留档）※ 全绿：wgk- 单 scope **10 工具 + 50 条真实结果**（首条 (2025)赣0321执恢112号）；admin 双 scope 10 工具；wire-only 403；无凭据 401
- [x] 3.2 可观测性验证：构造 server 级拒绝（wire 过 validate 后的场景或单测路径），error.log 出现含 server_id+scope 列表的 WARN（验证：`grep` error.log 新 WARN 行）※ 现网配置下拒绝路径不可达（入口 scope 集=required 集，any-of 下凡过边缘必过门）——以捕获式 ngx.log mock 单验：`Virtual server scope gate denied method=tools/list server=srv-warn required=["scope-a","scope-b"] caller_scope_count=2` PASS；生产 error.log 无 WARN（符合设计）
- [x] 3.3 通报用户 → 用户转告对面会话复验 E2E（7.1 收口、8.4 报告定稿）；更新记忆 [[lex-legal-virtual-scope-diagnosis]] 为已修复态
- [x] 3.4 openspec 收尾：validate `--specs` 通过后归档 change（specs/virtual-mcp-servers 并入主 specs）
