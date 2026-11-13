# Design: add-model-session-boundary-apply

> 出处：add-wake-budget-admission（2026-11-05）design 的 P2 重审注记转正立项。机制事实均经代码核实。

## 已核实的事实基础

1. **热切机制已在活体内运行**：pod 成员会话首用时，`harness/dsh.js` 在活进程内逐成员执行 `preset/set` + `model/set`（add-dsh-pod-adapter 既有件，`#prepared` 停车集合，resume 路径同构解析，组合不漂移）。
2. **identity drain 的现行清单**：`manager.js #identityOf` 十二字段（v/persona/skills/mcp/mcpTools/name/budget/secretRefs/billingKeyRef/notify/workspace/model）任一变更 → `drainAndStop` → 下次 touch 重生。pod 模式下任一成员变更排干**整个 pod**（add-dsh-pod-adapter 自认的「the accepted pod trade」）。
3. **ADR-0019（2026-10-07）**：模型入服务配置、写时车道校验、变更走「升级同款排水重生」，并锁「不引入第三种重启通道」。当时的语境=热切通道尚不存在。

## 设计

### 1. identity 拆两类

`#identityOf` 摘出 `model`，余十一字段维持组合身份。reconcile 的 identity pass 逻辑不变（组合身份变了才 drain）。

### 2. 模型热更新路径

- reconcile 增加一段轻量对账：per-key 比较 descriptor 的 `effective_model`（provider/model 二元组）与运行时停车图记录值；不同则调 adapter 的 `updateMemberModel(agentKey, {provider, model})`。
- adapter 侧（solo 与 pod 同构）：更新 `podMembers.get(key).{provider, model}`（solo 即单成员图的唯一项）；**不触碰 `#prepared`**——已停车会话维持其旧模型到结束（会话边界语义由 dsh bridge 的「停车在会话惰性创建时」原语保证，本单不造新原语）。
- 计费/预算字段（turnTimeoutMs/budgetLabel）不在本单范围——预算仍是组合级（物化于 spawn）。

### 3. 与排水重生的交互

组合级变更（含 packVersion）仍走排水重生；重生后的新 child 从 descriptor 取当前 effective_model 物化——混合变更一次排水完成，不叠加两次中断（spec 场景「模型+组合级混合变更」）。

### 4. 语义边界（charter 对齐）

会话边界生效 = 不改在途行为，与 `docs/agent-domain-design-charter.md`「授权不可变——防止改配置悄悄改在途行为」的假正常禁区一致：在途会话直到结束都在旧模型上，可预期、可观测（水面上的新旧并存，不是静默替换）。

## 兼容与风险

- **部署者无感**：deploy API/服务配置面零变化；生效时间从「≤5min 排干重生」变为「≤5min 新会话生效」，体验只升不降。
- **计费**：模型决定 sub2api 车道与价格档；在途会话旧模型照旧计费（本来就在跑的回合），新会话新车道——账目按实际车道归属，无串档。
- **resume 路径**：已停车会话跨 child 重生 resume 时，bridge 按停车记录解析旧模型——既有同构语义，本单不改。
- **风险：车型回退误判**——若 reconcile 与 spawn 物化竞态读到旧 descriptor，热更新可能写旧值。对策：热更新以 reconcile 周期幂等对账收敛（每轮重读最新 descriptor），最终一致。
- **风险：pod 兄弟会话干扰**——`updateMemberModel` 只写单成员条目，不触碰兄弟的 `#prepared` 与在途 collector；风险面=实现走样，测试钉死（pod 单成员热切用例）。

## 非目标（防蔓延）

- pod 组合级变更的爆炸半径重审（成员级物化）——密度信号到了另立。
- persona/技能热切——dsh 组合原语未提供，不硬造。
- 预算热切——预算物化于 spawn（turnTimeout），保持组合级。
