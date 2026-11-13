# Tasks: fix-cell-catalog-a2a-face

## 1. registry-bridge：facet 源补拉 agents

- [x] 1.1 `doFacetRefresh` 追加 best-effort agents 拉取（`fetchAllPages("/api/agents")` + 既有 `mapAgent` → `agentSnapshot`）；失败单独 warn 保 last-good，不拖累 mcp/skills 刷新；`REGISTRY_URL` 为空走同一降级分支 → 实施修正一处：`fetchAllPages` 返回 `{items}` 非裸数组（测试当场抓出）
- [x] 1.2 广播签名保持只看 `{mcpServers, skills}`（agents 不进 market_changed）；init 告警文案更新（agents 腿仍读 registry）；biome/typecheck 过

## 2. 测试

- [x] 2.1 `test-supply-catalog-yizuo.mjs`：facet 渠道补 registry agents 断言——填充 + a2a 条目 url 形态 + agents 独立降级（失败不拖累 mcp/skills、保 last-good）+ agents 变化不广播；env 恢复 `REGISTRY_URL` 设入（agents 腿的合法 base）→ 10/10
- [x] 2.2 全量相关套件回归（registry-bridge / supply-catalog / catalog* / pack-install-fetch）绿 → **46/46**

## 3. 出片与上产

- [x] 3.1 提交 `4c628f16e` 双推全等 + 快照闸出片（**--init + toplevel 前查**执行到位；两道新拦=并发会话 desktop-lane 内网拓扑文件入 EXCLUDE_PATHS）→ 快照 ea00a0a + workflows 恢复 **d13fbc1** → CI run 42321885024 绿
- [x] 3.2 relay `09:11:50 OK yizuo/platform:sha-d13fbc1 (4s)` → ccr skopeo 硬门 digest `ec71a1cb` → GitOps `f3149fb` 双清单 → ArgoCD hard-refresh → **双 pod imageID `ec71a1cb` 逐字全等**（platform-6665897c8d-h6h5j / platform-demo-847fb4858d-kjt6x；前版 sha-4d2dbfb 回滚可用）

## 4. 真机验证（O8 4.3/4.4 的解锁判据）

- [x] 4.1 **复活实证**：`/api/catalog` 93 agents / **29 a2a-mode**（此前 0）；7 支既有 a2a 岗全部复活（vacant→on_duty/paused/passive，servingPath 全部解析出真部署路径 `/packs/<packId>/<agentId><suffix>`）
- [x] 4.2 **正路径全判据过**：验证舰队 `fleet_1794014195618_jjf1l1`（用后即焚）挂 fingpt 岗 → dryRun `summonable=[{ref:"vtdpsNmtW6OQ9I99mBhbDw:pack-demo-fingpt", title, targetId, onBehalfOf:admin@finddatatech.cloud}]` → 执行 `results ok:true inviteId:inv_7ed541636d66b2c127`（生产 zhiyu.db 邀请行 kind=agent/on_behalf_of=部署者/state=pending 如实）+ 订阅随行；验证房 end、舰队删
- [x] 4.3 走查单 2.6 执行半边回填 + O8 4.3/4.4 回填勾选；O9 行改「已解除」（另见台账续五）

## 5. 收口

- [ ] 5.1 `openspec validate --strict` 两单全绿 → 两单 strict 绿（下步归档）；台账续五在册
