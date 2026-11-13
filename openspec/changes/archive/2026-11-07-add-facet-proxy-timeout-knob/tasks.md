## 1. 代码与清单

- [x] 1.1 `gateway/index.js`：`registerFacetProxy` 调用新增 opt-in `timeoutMs`（`FACET_PROXY_TIMEOUT_MS > 0` 才传），未配置时逐字节向后兼容
- [x] 1.2 `fd-infra-deploy/all-services/prod/platform.yaml`：platform Deployment 增 env `FACET_PROXY_TIMEOUT_MS=120000`
- [x] 1.3 `gateway/facet-proxy.js` 读码确认 `timeoutMs` 贯穿到 `AbortSignal.timeout`，无缺陷、不改
- [x] 1.4 验证：`node --check gateway/index.js` 通过；`platform.yaml` YAML 解析通过；scoped diff 仅新增行

## 2. 出片与滚动

- [x] 2.1 提交两个文件（**只 add 具体路径，不 `git add -A`**，避开并发会话改动）
- [x] 2.2 平台镜像出片（既有 GHA→tcr-relay→GitOps 通道）——image `sha-c66493f`
- [x] 2.3 ArgoCD 同步 / 滚动 platform，env 生效——pod env `FACET_PROXY_TIMEOUT_MS=120000`、代码 `code_has_knob=2`

## 3. 部署键落库验证

- [x] 3.1 部署键落库——API deploy 因 `deployToRegistry` >120s（每技能匿名 SKILL.md 抓取）仍超时；改走与 `recordDeploymentKey` 同语义的手工 upsert（真 PK=`pack_id,agent_id`），三行 ref 与描述符逐一对应；写前已备份 packs.db。**挂账**：`deployToRegistry` 自身 >120s 的慢因与 facet-proxy 无关，另立
- [x] 3.2 facet `deployment_keys` 三行（20→23）
- [x] 3.3 runner-c 日志 `running on its own billing key (ref pk_…)` ×3，child cold-start v7/v9 常驻

## 4. 试点 E2E 补跑

- [x] 4.1 A2A `message/send` 真回合出产物（非 -32003）——三单元 runner 车道 200/29.6s、91.3s、61.7s 全出真产物；萬星 facade 外部车道 200/34.8s
- [x] 4.2 成功回合分钟计费实证——三本账齐：runner meter（tokens/durationMs）、sub2api 按 key 成本（$0.0402, isValid）、facade `wanxing_usage` `minutes_billed=1 settled`（wu_a209c93f46f4cc3d0）
- [x] 4.3 模拟盘 run 真起来 + 三方对账——fd-paper-trading sha-3be3d49 astock run RUNNING、`last_bar_date=2026-07-10` pinned 真值、零 error；证据 `fd-paper-trading/scripts/evidence/c2-paper-run-reconciliation-2026-11-07.md`（对账拦下三真缺陷：老镜像 simulated 回落 / ASTOCK_DSN 口令错串 / secret 占位覆盖丢三键，均已修）
- [x] 4.4 证据落 `reports/`——`reports/c1-deploy-keys-and-billing.md`；不满足项（deployToRegistry 慢因、template run price_caliber 不落）如实挂账

## 5. 收尾

- [ ] 5.1 `openspec validate add-facet-proxy-timeout-knob --strict` 通过后归档
