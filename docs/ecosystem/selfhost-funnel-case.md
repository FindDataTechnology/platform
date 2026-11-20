# 自部署漏斗案例卡 · The Self-Host Funnel Case Card

> F3.3 验收产物（`add-funnel-acceptance`，2026-10-13）。一次真实旅程的五跳实录——
> 从「包发布在自己的实例上」到「外部调用者真金付费、部署者分成落账」。每一跳的
> 命令、响应与账本行都来自生产环境实跑，不是拼接。**这张卡是漏斗的回归基线**：
> 任何一跳断链，先读本文「边界与坑」节再排查。

## 旅程一览

| 跳 | 动作 | 生产证据 |
|---|---|---|
| ① 自部署发布 | 本地 facet 实例（同版本代码）+ 真 vertical manifest | 实例 detail：`市场快讯 · 一页速览` v1，serving agent `market-flash-briefer` |
| ② 官方上架 | `facet publish <id> --from http://127.0.0.1:3299`（静默续登） | 官方 id `ev5E51eth7e5McvyDrl9Rg` v1，作者 platform-test@findmail.com，保持公开 |
| ③ 萬星部署 | 控制台部署端点（向导同源），绑定部署者自有 sub2api 键 | `deployed:[{agentId: market-flash-briefer, slug: packs-ev5e51…}]`，目录 `deployable:true` |
| ④ 真金回合 | 外部调用者（独立账号键 73）`POST /a2a/<slug>` message/send | 15.5s 真回合，506 字固定版式速览；usage `wu_c75a7720…` 1min×$0.10 settled |
| ⑤ 分成落账 | trySettle 成功旁路→`wanxing_deployer_earnings` | deployer=platform-test，revenue $0.10 → **share $0.07**（抽成 0.30），settled |

身份拓扑（分成条件「调用者≠部署者」成立）：**作者=部署者**=platform-test（sub2api
用户 78，键 `wx-wizard-verify`）；**外部调用者**=用户 73（`p6e1c045…@paas.platform`
钻取账号，余额充值 $2 运维操作）。

## 旅程实录（命令级）

```bash
# ① 自部署实例发布（manifest 经 validatePackManifest 对拍）
node -e 'createPackRegistry({file:"packs.db"}).publish({email:"selfhost-owner@local", manifest})'
# → {"id":"Bk1x3Qk0RQMbta_hSa_PZw","version":1}

# ② CLI 回流官方（F3.2 桥；设备已配对→静默续登零提示）
facet publish Bk1x3Qk0RQMbta_hSa_PZw --from http://127.0.0.1:3299 \
  --market https://facet.finddatatech.cloud --no-open
# → 已发布到官方市场：ev5E51eth7e5McvyDrl9Rg v1（作者 platform-test@findmail.com）
# → 已记 id 映射 Bk1x3Qk0RQMbta_hSa_PZw → ev5E51eth7e5McvyDrl9Rg

# ③ 萬星目录收录（自动）+ 部署（控制台向导同端点，键=部署者自有）
POST /api/wanxing/v1/console/my/packs/ev5E51eth7e5McvyDrl9Rg/deploy
  { agents:["market-flash-briefer"], billingKey:"sk-…（部署者）",
    models:{"market-flash-briefer":"deepseek-v4.1-flash"} }
# → 200 deployed；runner-b/c 拾取（≤5min），"running on its own billing key"

# ④ 外部调用者真回合（Idempotency-Key 防重放）
curl -X POST https://wanxing.finddatatech.cloud/api/wanxing/v1/a2a/packs-ev5e51…-market-flash-briefer \
  -H "Authorization: Bearer sk-…（调用者 73）" -H "Idempotency-Key: …" \
  -d '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"parts":[{"type":"text","text":"<财经文本>"}]}}}'
# → 200，result.parts[0].text = 【速览】央行降准0.25个百分点 / 结论×3 / 要点×5 / 存疑×1

# ⑤ 台账（facade wanxing.db）
# usage: minutes_billed=1 rate=0.1 settlement_status=settled caller_id=73
# earnings: revenue_usd=0.10 amount_usd=0.07 commission=0.3 status=settled deployer_user_id=78
```

产线样本：官方市场 `ev5E51eth7e5McvyDrl9Rg`（公开保留）+ 在役 agent
`packs-ev5e51eth7e5mcvydrl9rg-market-flash-briefer`（真部署，可对话）。

## 诚实边界（读卡须知）

1. **分成是部署者收益账，不是作者账**（ADR-0022）：作者发布包本身不产生收入；
   发布者吃分成的方式是**自己部署自己的包**（本卡即此形状）。MineView 文案
   「你按分成获得收益」按此理解。v1 无提现——收益只抵部署者自身消耗。
2. **失败回合不分成**（负保护）：`outcome:error` 行 waived、零分成（旅程中有一条
   20ms 失败回合实证）；「模型报错后 dsh 会话照常 idle」的空回合自 2026-10-13 起
   按失败结算（-32005→outcome:error→免单，见坑 ②）——失败类回合全谱不分成。
3. **模型选择是两道门**：部署时只验证**计费车道**（sub2api 键的 /v1/models）；
   子进程真正能调的模型还受 runner 的 dsh 花名册（settings.yaml 8 模型）约束。
   只在车道不在花名册的模型会**静默空返**（见坑 ②）。选花名册∩车道的交集。

## 本次验收发现并处置的坑

| # | 坑 | 处置 |
|---|---|---|
| ① | **并发双部署拧断 billing_key_ref**：同包两次并发部署交错（registry 先后手≠库表先后手），registry 指向已轮换死 ref→runner 取键 404→**静默回落共享键**，部署者键停止计费且车道随机不通 | **已修**（4dd46b2）：deploy 路由按 packId 承诺链串行整段写序；`scripts/test-deploy-lock.mjs` 2/2（无锁复现 desync 实证）；镜像随本片滚 |
| ② | **车道≠花名册 + 错回合照计费**：`inclusionai/ling-3.1-flash` 过车道门但不在 dsh 花名册→子回合 UNKNOWN_MODEL 静默空返；且 facade send 路径只看 HTTP 状态（A2A 错误随 **HTTP 200** 返回）→模型失败回合 **outcome:ok 照常计费+分成**。2026-10-13 runner 拆分切换日上游大面故障时升级为真实事故（两笔 502 回合照扣费） | **计费侧已修**（fd-wanxing `fix-error-turn-billing`，sha-ed21d00）：错回合豁免（生产复核：503 回合 outcome=error/0 分钟/waived）。**部署门已修**（paas `add-deploy-roster-gate`，sha-53ef436）：三层验证，事故原模型生产实证 400。**配置门+现患已清**（paas `add-config-roster-gate`，sha-ff19181）：配置写同门；在役 wx-alpha 挂 ling-3.1-flash 的现患清 null 回默认，全条目零不在册。**同批揪出并修复配置写 URL 自环缺陷**（GET 显示 URL 回写→4 条目 A2A 断路；PUT 前按宿主几何重建 origin）。**采集器语义项已修**（paas `fix-empty-turn-billing`，sha-82f671b/镜像 sha-5187ddc 三 runner 同滚）：idle 零 assistant 文本按失败结算 -32005（判别式=文本——当时 700/700 ok:true 行 tokens:null 的真因是同批修掉的 tokensOf 字段名错配，见 fix-turn-token-attribution：分列 usage 求和后已见真数值 428）；生产探针复现事故原形状（roster 外模型直写注册→静默 idle）实证 HTTP 200+JSON-RPC -32005+计量 ok:false；-32003（自报失败）/-32005（静默空返）双码区分归因。。**tokens 归属同批修复**（paas `fix-turn-token-attribution`，sha-b1e0d7d/镜像 sha-d38c1aa）：dsh harness usage 实为 camelCase 分列（pi-ai 适配器每个终态事件必发 usage chunk，agent-loop 挂 assistant/message 的 data.usage），tokensOf 补分列求和；滚后生产实证 ok:true+tokens:428（700/700 恒 null→真数值） |
| ③ | **免费车道 429 拥挤**：free 系模型上游限速频繁（重试 5 次耗尽仍空返） | 部署键改绑 openrouter 组（paid 车道）；运维操作记录在案 |
| ④ | **调用者停权自愈链**：余额不足→结算连败 30×→CALLER_SUSPENDED；充值后 pending 扫尾结算成功→自动清停权 | 语义正确（防滥用）；充值即恢复，无需手工解封 |

## 维护

- 重跑验收：按「旅程实录」五跳复演，比对每跳的响应/账本形状。
- 本卡由 `add-funnel-acceptance`（F3.3）立卡；漏斗行为变更的 change 应同步本卡。
