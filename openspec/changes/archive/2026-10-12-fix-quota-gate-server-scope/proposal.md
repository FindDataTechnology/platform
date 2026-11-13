# fix-quota-gate-server-scope

## Why

wire 线的当月行数门（wire-self-serve-launch 3.2，2026-10-10/11 上生产）对所有非 admin 的已映射 caller 在**全舰队 server** 上探测 wire 额度端点。lex 线客户共享同一个 `SUB2API_CALLER_MAP`（env 层，sub2api id 56），在 wire 库中无客户映射 → wire 端点 404 → 门判 `QUOTA_UNAVAILABLE` → 无条件 fail-closed 503：lex 直连入口（`lex.finddatatech.cloud/mcp`）对 lex 客户整线不可用。门是为 wire 客户/wire server 设计的，却作用于不属于它管辖的线——这是跨线误伤，需要根治（用户 2026-10-12 定调：wire 门只管 wire 的 server；不在 wire 库建任何 lex 映射数据）。

同事故排障中暴露第二个缺陷：registry 审计流中被门拒绝的调用只有 `/validate` 写下的一条 `mcp_response.status=success`（语义=鉴权成功，写在 mcp-proxy 跳之前），mcp-proxy 跳的实际拒绝结局在审计流中无任何记录——审计流对被拒调用会说谎，误导排障（已实际烧掉 finddata 会话一轮），并构成对账幻影用量风险。

## What Changes

- **行数门增加 server 作用域**：新增 env `FD_WIRE_QUOTA_SERVERS`（逗号分隔的 registered server 名单）。未设 = 维持现状（门对所有 server 生效，向后兼容）；设了 = 门只对名单内 server 生效。匹配键为 registered server name（proxy path 首段，剥尾部 transport 段 `mcp`/`sse`/`messages`）。
- **门内全部分支随作用域豁免**：line-quota 探针、`target_kind != "user"` fail-closed 分支、`MONTHLY_QUOTA_EXHAUSTED`/`QUOTA_UNAVAILABLE` 拒绝，均只对名单内 server 发生。**余额门不受影响**（lex 客户余额耗尽仍 402 `INSUFFICIENT_BALANCE`）。
- **mcp-proxy 跳写拒绝审计**：`mcp_proxy` 端点内各准入门（preflight / tier / scope / call-grant）抛 `HTTPException` 拒绝时，重抛前经 mcp_logger 写 definitive 拒绝审计事件（同 request 身份、status=refused + error_code）。`/validate` 的 success 审计保留（虚拟路径的唯一审计来源），但不再是最后一条记录。
- **验收场景 6 重释**（原字面"被拒调用不得产生审计 success 记录"不可实现——/validate 先于 mcp-proxy 运行，无法预知结局）：被拒调用在审计流中有明确的 refused 记录，对账取最终记录。
- wire 侧零数据变更；lex 侧零代码变更。

非破坏性变更：`FD_WIRE_QUOTA_SERVERS` 未设时行为与线上完全一致；两步灰度（先发码、后设 env）保证任意一步可独立回滚。

## Capabilities

### New Capabilities

- `registry-quota-gate`: registry 预检层 wire 行数门的行为契约——管辖作用域（哪些 server 归门管）、verdict 教义（fail-closed 边界）、与余额门的条件关系、豁免维度（admin caller、线外 server）、以及 mcp-proxy 跳拒绝审计的最终局语义。既有 specs 无此能力承载（platform-billing 是部署者侧余额门；wire 线 3.2 spec 落在 finddata 根 openspec，registry fork 谱系归 paas 管）。

### Modified Capabilities

（无——`registry-quota-gate` 为新建，首版契约直接包含作用域语义。）

## Impact

- **代码**（registry fork，`mcp-gateway-registry` wire-onboarding 谱系）：`auth_server/preflight_quota.py`（作用域条件 + 本地 server-name 规整助手）、`auth_server/server.py` `mcp_proxy` 端点（拒绝审计包装）、`tests/auth_server/unit/test_preflight_quota.py`（新增 `TestWireQuotaGateScope`：in-scope/exempt/未设=全量/transport 段匹配）+ 拒绝审计测试。
- **部署**：GHA→hkccr→relay→ccr 标准线 + cheap-1 `/opt/mcp-gateway-registry` compose；两步灰度——①发码（无 env，行为零变化）→ ②`.env` 设 `FD_WIRE_QUOTA_SERVERS=<wire server 清单>` 重启 auth-server。回滚 = 去 env 重启，或 `FD_WIRE_QUOTA_GATE=false` 总闸。
- **运维面**：新 wire server 注册后须同步进名单（runbook 条目）；名单核对配方 = auth-server 容器内 `grep mcp_preflight_quota /tmp/preflight_quota.jsonl | jq -r .server | sort -u`。
- **不受影响**：虚拟入口（`/_vs_backend` nginx 直连上游，不经 /mcp-proxy，天然不过门）；wire 客户在 wire server 上的行数门与 free 档 `enforce_balance=false` 语义；lex 侧自有计费/对账/额度端点。
