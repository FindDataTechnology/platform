# design.md — fix-quota-gate-server-scope

## Context

- 门出生于 wire-onboarding 谱系（commit `0aad2b53`，2026-10-10/11 上生产）。应用条件 `preflight_quota.py:895`：`_quota_gate_enabled() and not _is_admin_caller(claims)` ——无 server 维度。caller map（`SUB2API_CALLER_MAP`）跨线共享：wire（sub2api 16/71）与 lex（56）同住一张表，门无法按 caller 区分线。
- 直连入口拓扑（Issue #1026）：nginx location → `auth_request /validate` → `proxy_pass auth-server/mcp-proxy/{server}`。**虚拟入口**走 lua virtual_router → `/_vs_backend*` **nginx 直连上游**，不经 /mcp-proxy，天然不过门。
- 缺陷四翻案（已核实）："被拒调用仍被转发"不成立——`/validate`（server.py:5042）写的 `mcp_response.status=success` 语义是**鉴权成功**（11.7ms = JWT 验证耗时），写在 mcp-proxy 跳之前；preflight raise 位于该端点唯一 httpx 转发（~8887）之前，同协程必短路；后端 pod 的 200 来自同时段的虚拟入口探针。真实缺陷是**审计最终局缺失**：mcp-proxy 跳的拒绝在审计流无记录。

## Goals / Non-Goals

**Goals:**

- lex 客户经直连入口恢复全功能（initialize/tools/call），不要求 wire 库有任何 lex 数据。
- 行数门管辖权 = wire 线的 server；未来任何新线自动豁免（lex 类事故模式不可复发）。
- 审计流有拒绝最终局记录，对账不再产生幻影用量。

**Non-Goals:**

- 不做 per-line quota 端点路由（方案 B）：lex 自有双单位额度面保持独立，不引入契约适配。
- 不做未知 caller 降级放行（方案 C）：与"无主调用必须拦"教义冲突。
- 不动 `/validate` 审计本身（虚拟路径唯一审计来源，重命名/搬移破坏面大）。
- 不为 server 增加归属元数据模型（schema+注册面改造，与事故体量不成比例）。
- wire 侧、lex 侧代码零变更。

## Decisions

**D1 作用域来源 = env 名单（opt-in），不用 registry 元数据、不用 exemptlist 极性。**
`ServerInfo` 无 owner/line/tenant 字段，元数据路线要先造概念；exemptlist 极性（名单=豁免）会把 lex 类事故复制给每条未来新线（新线上客户、豁免表不认识 → 又被门咬）。opt-in 名单使"新线自动豁免"成为结构性保证。

**D2 极性：未设 = 全量（现状），设了 = 只管名单。**
反向定义（空 = 全关）会伤 wire free 档：`enforce_balance=false`（跳余额门）来自 wire quota 响应，行数门整块被跳过后余额门无条件执行，free 档 0 余额客户会突然吃 402（破坏验收场景 5）。未设 = 现状同时保证发码零行为变化（灰度第一步）。
代价：新 wire server 忘进名单 → 行数门静默失效。缓解见风险区。

**D3 作用域条件包住整个 line-gate 块**（含 `target_kind != "user"` fail-closed 分支）；**余额门在块外，不动**——lex 豁免后余额门照跑（验收场景 3：402 仍拦）。

**D4 匹配键：registered server name（首段 + 剥尾部 transport 段），preflight_quota 内本地实现。**
不 import server.py 的 `_registered_server_from_proxy_path`（server.py 懒 import 本模块，反向顶层 import 虽不致循环但脆）。本地助手语义一致，测试钉死两侧等价（含 federated `peer/server` 完整保留）。

**D5 拒绝审计 = mcp_proxy 调用点 try/except 包装，重抛前写 mcp_logger 事件。**
包装范围覆盖四闸（tier / scope 授权 / preflight / call-grant）的 `HTTPException`，一处模式不挑食；identity 从已验证 claims 构造（复用 /validate 侧 Identity/MCPServer 构形），status=refused + error_code 取自异常 detail。放调用点而非 preflight 内部：mcp_logger 句柄（`get_mcp_logger`）住在 server.py，且四闸统一包装只能在调用点做。

**D6 场景 6 重释**：/validate 先于 mcp-proxy 运行、无法预知结局，"不产生 success 记录"不可实现；重释为"同一请求存在 refused 最终局记录，对账取最终局"（spec 已按此立约）。翻案以判别性探针钉死：直连入口唯一 id、虚拟入口静默、tail 后端 pod log → 无 POST 到达。

## Risks / Trade-offs

- [新 wire server 注册后未进名单 → 行数门静默失效] → runbook 条目（注册即核对名单）+ 名单核对配方（容器内 `grep mcp_preflight_quota /tmp/preflight_quota.jsonl | jq -r .server | sort -u` 枚举在管集合）；余额门仍兜底；审计流中该 server 无 mcp_preflight_quota 事件即可侦破。
- [名单手误（拼错 wire server 名）→ 该 server 豁免] → 同上侦破；部署验收含名单内 server 的门生效探针（验收 4）。
- [拒绝审计为每次拒绝增加一次 Mongo 写] → 拒绝是异常路径；放行流量零新增成本；/validate 本就每请求一写。
- [被拒调用仍留有 /validate success 行] → 已立约（对账取最终局）；spec 场景明示两行并存取 refused。

## Migration Plan

1. 从 `wire-onboarding`（= scs001/main 谱系）拉 fix 支线；实现 + 测试（`TestWireQuotaGateScope` 新类 + 既有五类不回归 + 拒绝审计测试）。
2. 标准镜像线：GHA→hkccr→cheap-3 relay→ccr（deploy-registry-image skill 配方）。
3. **灰度第一步**：cheap-1 compose 换 tag，**不设 env** → 行为零变化（验证：wire 场景 4/5 照常；lex 仍 503 属预期中间态）。
4. **灰度第二步**：枚举 wire server 清单 → `.env` 设 `FD_WIRE_QUOTA_SERVERS=<清单>` → 重启 auth-server → lex 恢复。
5. 验收：移交包场景 1-5、7 + 重释后的 6 + 判别性探针。
6. 回滚：去 env 重启（回到现状：lex 503、wire 无损）或 `FD_WIRE_QUOTA_GATE=false` 总闸（门整体下线）。

## Open Questions

- wire server 名单的具体条目：部署第二步时从 jsonl 配方 + wire onboarding 记录枚举即可，不影响本设计的任何决策（可安全延后）。
