# Tasks — fix-deploy-binding-mint-process

## 1. 实证（已完成）

- [x] 1.1 证实 `/api/packs` 前缀在 `FACET_BASE_URL` 下被代理到 facet，deploy 路由在 facet 进程执行
- [x] 1.2 证实 facet 无 `mcp.json`（`connector_not_configured`），挂 `platform-mcp-config` 后转为 `no_account`
- [x] 1.3 证实 facet 无 `/data/data`（数据根 `/data/facet`），即无 cell 库、无用户连接器账号
- [x] 1.4 真机演练产物已清理（注册处 DELETE 204 → 404、卸包、台账 deprecated、部署/密钥/包行归零）

## 2. 实施（已完成）

- [x] 2.1 cell 侧铸造门 `POST /api/gateway/binding-mint-batch`：用**本侧台账**算 mintable（台账只在 cell，
      实测 facet 侧 `mintableBindings()` 恒空），逐 (agent,key) 铸，回 `granted`（含值）+ `keys`；
      配置 `CELL_GATEWAY_SECRET` 时校验网关头
- [x] 2.2 撤销门 `POST /api/gateway/binding-revoke`：keep-set 由 cell 按台账自算，只吊销
      `deploy:<pack>:` 命名空间内的令牌
- [x] 2.3 网关中继 `/api/gateway/binding-mint(-batch)`、`/binding-revoke`：`FACET_INTERNAL_TOKEN` 鉴权后
      按邮箱 `registry.ensure` 取 cell；**显式构造身份头**（复用 `forwardedHeaders` 会带上调用方的
      content-length → undici `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`，表现为 cell_unreachable）
- [x] 2.4 facet 侧：`hasLocalConnectorAccount` 为假且已配通道时整批借铸并**本地落 deployment_secrets**；
      无通道则退回本地判断（单进程部署语义不变），失败只降级不阻断部署
- [x] 2.5 单测 `test-binding-mint-channel.mjs` 5/5：本地不调通道、市场面整批借铸并本地落库、拒绝降级、
      无通道退回本地语义、撤销走通道且只在本命名空间
- [x] 2.6 真机闭环（2026-11-08，镜像 `sha-d37c9fd` / 基线 paas `3a45a8bfc`）：
      ① `deployment_secrets` 落 `connector_binding_market`（47 字令牌，deployer 记名）；
      ② 连接器上出现 `deploy:<pack>:drill-writer:market`，`allowedOperations=[alpha_vantage/read]`，
      父令牌是该用户账号；③ descriptor 同时带 `connector_bindings` 与 `secret_refs`；
      ④ 用该令牌真调连接器 `initialize` + `tools/list` + `call_tool(list_connections)` 全部 200；
      ⑤ 撤销后同一令牌立即 401。产物已清零（注册处 DELETE 204、卸包、台账 deprecated、
      部署/密钥/包行归零、连接器残留 deploy 令牌 0）
- [ ] 2.7 未跑：让岗位在**真实回合**里调用连接器工具（runner 侧物化是懒加载，需一次 A2A 回合；
      该段的取值与拼装由 `test-connector-binding-entries` + 本变道的 descriptor 证据覆盖）

## 3. 明确不做

- [ ] 3.1 不放宽父凭证（不接受服务身份代铸）
- [ ] 3.2 不把 cell 数据目录暴露给 facet
