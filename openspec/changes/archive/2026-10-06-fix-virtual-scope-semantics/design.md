# design — fix-virtual-scope-semantics

## Context

线上 registry（cheap-1 compose 栈，`mcp-registry:sha-c4b0994` = github main tip = fd-1.1.1）的虚拟 MCP 聚合层经 2026-10-06 实测全链健康：mapping 文件生成（`nginx_service._write_virtual_server_mappings`，`generate_config_async` 内联调用）、`_vs_backend_*` 后端块渲染、lua 会话管理（L1 30s/L2 Mongo）、SSE 解析均正常。唯一缺陷是 `virtual_router.lua` 的 server 级 scope 门：`_has_scopes`（AND）用于 6 处 server 级检查，与 `mcp_scopes_default.server_access` 的 either-or 授权模型错位，导致一切单 scope 真实凭据（全部真实客户）被拒。排障实测矩阵（wgk- 客户 key / 双 scope 自签 admin JWT / wire-only 自签 JWT 三向对照）已把根因钉死在门语义，证据在 [[lex-legal-virtual-scope-diagnosis]] 记忆与会话记录中。

## Goals / Non-Goals

**Goals:**

- server 级 scope 门语义改为 any-of，与授权模型自洽，解锁 lex 客户全链
- per-tool scope 门保持 all-of，合取需求（如"写操作需双授权"）不受影响
- 拒绝可观测（WARN 日志），杜绝"静默拒绝被误诊为聚合空结果"重演
- 走标准发布线（push github main → GHA → hkccr → cheap-3 relay → ccr → cheap-1 registry-only pin），版本 fd-1.1.2，回滚锚保留

**Non-Goals（设计层补充，proposal 级见 proposal.md）:**

- 不改 lua 的会话/缓存/聚合逻辑（健康，勿动）
- 不引入 scope 语义配置项（不搞 per-server AND/OR 开关——一个全局语义，配置面最小）
- 不动前端、不动生产 Mongo 数据

## Decisions

### D1: any-of 谓词而非拆门

新增 `_has_any_scope(user_scopes_str, required_scopes)`：列表空/缺 → true；用户 scope 串空 → false；任一命中 → true。替换 6 处 server 级调用点。**备选被否**：完全移除 lua server 门（入口全交 validate）——失去纵深防御，scope 文档配置错误时裸奔；维持 AND 改数据（已否）——把语义负担转嫁给每个虚拟服务器的配置者，footgun 仍在。

### D2: per-tool 保持 `_has_scopes`（AND）

`_handle_tools_call` 的逐工具检查与 `_handle_tools_list` 的列表 scope 过滤不动。工具级多 scope 是合取语义的自然栖息地；现网 lex-legal per-tool 全空，无存量行为变化。

### D3: 拒绝留痕 WARN（语义生效时）

server 级拒绝处记 `ngx.WARN`：server_id + required_scopes 列表 + 用户 scope 数（不落用户 scope 明文，避免日志扩散授权面）。本次事故排障成本一半来自拒绝静默。

### D4: 载体分支 = github main（订正交接文档的 fd-1.0.0）

线上 = main tip `c4b0994`；fd-1.0.0 落后 12 提交（发它=回滚 i18n）；fd-i18n-ui 带 2 个未发布提交（identity_forwarding 等）不混入。从 main 切 `fix/virtual-scope-semantics`，直推合回（`git push origin HEAD:main`，仓库现行惯例，GHA `on: push: branches: [main]` 触发构建）。gitee 镜像同步不阻塞发布。

### D5: cheap-1 只滚 registry 服务

GHA matrix 同时构建 mcp-registry + mcp-auth-server，但线上 pin 本就分服务（registry=`sha-c4b0994`、auth=`sha-676a245`）——只改 registry pin + `up -d --no-deps --no-build`。auth-server/mcpgw 不碰（并行 wire 会话纪律）。registry 重启的秒级全代理间隙：构建就绪后**等用户 go**（用户与对面会话对齐窗口）。

### D6: 版本 bump fd-1.1.2

`image.yml` 的 `BUILD_VERSION` build-arg（fd-1.1.1 唯一出处）。一个发布一个版本，/api/version 是运维锚点与回滚辨识依据。

### D7: 单测走既有 harness

`tests/lua/test_virtual_router.lua`（`_G._VR_TEST` 钩子 + mock ngx）经已暴露的 `_handle_tools_list` 断言语义，不新增内部函数暴露。运行方式 `docker run --rm -v "$PWD":/app -w /app openresty/openresty:alpine resty tests/lua/test_virtual_router.lua`。回归用例形状 = lex-legal 事故本体（required={A,B} + 用户仅 A）。

## Risks / Trade-offs

- [语义放宽即授权面放宽] → 已实测三向对照闭环：无任何所需 scope 的凭据仍拒（lua 门）、无授权 scope 的凭据在 validate 403（边缘门）；两者都留在验收矩阵
- [GHA 构建的 auth-server 新镜像被误滚] → 部署 runbook 写死只改 registry pin；diff 检查 compose 变更后再生效
- [registry 重启间隙撞上 wire 会话测试] → D5 的等-go 门；对面会话优先级更高（交接纪律）
- [lua 改动引入语法错误导致 nginx 起不来] → 镜像内 lua 由 `Dockerfile.registry` 打包，本地单测先跑通再推；且 GHA 构建即验证打包，滚前 `docker run --rm <新镜像> nginx -t` 可选预检
- [回滚路径] → cheap-1 repin `sha-c4b0994` + `up -d --no-deps --no-build`（旧镜像本地仍在）；代码层 revert 单 commit

## Migration Plan

1. main 切支 → lua + 单测 + schema 描述 + WARN + BUILD_VERSION=fd-1.1.2 单 commit
2. 本地：docker openresty 跑 lua 全套（改前基线 → 改后全绿）+ `pytest tests/unit/core/test_nginx_service.py`
3. 直推 origin main 触发 GHA → hkccr → cheap-3 relay（cron */5）→ ccr
4. **等用户 go** → cheap-1 registry pin 改新 sha + `up -d --no-deps --no-build`（仅 registry 服务）
5. 验收矩阵：wgk- 全链（initialize → tools/list 10 工具 → wenshu_search ≥2 真实结果）/ 双 scope JWT 仍通 / wire-only 仍 403 / 无凭据仍 401 / 拒绝路径 error.log 出现 WARN
6. 通报用户 → 用户转告对面会话复验 E2E（7.1 收口、8.4 定稿）

## Open Questions

（无——grill 两轮已清空 frontier；发布时机由用户 go 控制，属流程门非设计未知）
