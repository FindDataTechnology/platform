# tasks.md — fix-quota-gate-server-scope

实施仓：registry fork（`/Users/chengsishi/code/mcp-gateway-registry-wire`，从 `wire-onboarding` 拉 fix 支线）。

## 1. 作用域实现（preflight_quota.py）

- [x] 1.1 新增 `_quota_scope_servers()`（解析 `FD_WIRE_QUOTA_SERVERS`，未设返回 None 语义=全量）与 `_server_in_gate_scope(server_name)`（首段归一 + 剥尾部 transport 段 `mcp`/`sse`/`messages`，federated `peer/server` 键完整保留）；新增 `TestWireQuotaGateScope`：未设=全量、名单内生效、名单外豁免、transport 后缀剥除、federated 键、空白容错——`pytest tests/auth_server/unit/test_preflight_quota.py -k Scope` 全绿
- [x] 1.2 将作用域条件接入 line-gate 块（包住含 `target_kind != "user"` fail-closed 分支在内的整块，余额门留在块外）；路由级测试三态：名单外 server 不发起 wire 探针（mock 探针断零调用）、名单内照常探针、豁免路径余额门照跑——对应测试通过
- [x] 1.3 等价性钉死：参数化用例断言本地归一与 `server.py::_registered_server_from_proxy_path` 对同一组路径（含 `peer/server/mcp`、裸 server 名、带 transport 段）结果一致——测试通过

## 2. 拒绝审计（server.py mcp_proxy）

- [x] 2.1 在 `mcp_proxy` 端点为四闸（tier / scope 授权 / preflight / call-grant）的 `HTTPException` 加统一 try/except 包装：重抛前经 `get_mcp_logger()` 写 refused 审计事件（与 `/validate` 审计同构的请求关联键与 Identity，status=refused + error_code 取自 detail）；单测：各闸拒绝各写一条含正确 error_code 的记录、放行流量零新增写、mcp_logger 不可用时静默降级不改变拒绝行为——测试通过

## 3. 回归与构建

- [x] 3.1 全仓回归：既有 `TestWireQuotaGate*` 五类（Config/Off/Exhausted/Allow/FailClosed）+ 全量单测零回归——`pytest tests/auth_server/unit/` 全绿
- [x] 3.2 从 `wire-onboarding` 拉 fix 支线提交并推 scs001；GHA 镜像构建（mcp-auth-server matrix）绿、hkccr→relay→ccr digest 三点核齐

## 4. 生产两步灰度（cheap-1 /opt/mcp-gateway-registry）

- [x] 4.1 第一步（发码不动 env）：compose auth-server 换新 tag 重启；验证 wire 回归不破（platform-test 调 wire server 200 + free 档 0 余额 200），lex 直连仍 503 属预期中间态——探针结果留档
- [x] 4.2 枚举 wire server 名单：auth-server 容器内 `grep mcp_preflight_quota /tmp/preflight_quota.jsonl | jq -r .server | sort -u` 对照 wire onboarding 记录定稿清单
- [x] 4.3 第二步（设 env）：`.env` 写 `FD_WIRE_QUOTA_SERVERS=<清单>` 重启 auth-server；验收移交包场景 1（lex initialize 200）/2（tools/call 200+真实数据+provenance）/3（余额耗尽 402）/7（jsonl 无 lex 拒绝行）+ 重释 6（审计流有 refused 记录）+ 判别性探针（直连入口唯一 id、虚拟入口静默、tail 后端 pod log → 无 POST）——全部留档
- [x] 4.4 回滚通道验证说明落 runbook：去 env 重启 = 回现状；`FD_WIRE_QUOTA_GATE=false` = 门整体下线；新 wire server 注册须同步进名单
