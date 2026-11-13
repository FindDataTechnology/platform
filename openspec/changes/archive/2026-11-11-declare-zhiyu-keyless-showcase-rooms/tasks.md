# Tasks — declare-zhiyu-keyless-showcase-rooms

> 本单先把口径写成契约。代码化（房间级开关 + 事件区分 expected）是 apply 阶段的事，未做前保持未勾。
> 前置事实（2026-11-11 实测）：演示房 `zy_42ce690574b5423bd2` 四席均无计费键；`settle_unbilled`
> 已在生产落行（21:30:53 seq 115、code NO_BILLING_KEY）；`pack_host_settlements` 保持 12 行未增。

## 1. 契约（本单主体）

- [x] 1.1 `zhiyu-room` 的「计费与配额挂钩」补展示模式：无键席位照常应答 + 未计费留痕 + 不得视为故障；只豁免"没有键"，不豁免日预算/应答上限/熔断/欠费谢绝
- [x] 1.2 区分两种口径：**展示模式（预期未计费）** vs **未声明房间（配置缺口，巡检可点名）**——这是本单最关键的一条，避免"没配上键"被伪装成正常态
- [x] 1.3 可读性：展示模式 SHALL 在房间详情/设置面可读，不得静默
- [x] 1.4 `openspec validate declare-zhiyu-keyless-showcase-rooms --strict` 绿

## 2. 代码化（apply 阶段）

- [x] 2.1 `zy_rooms` 增 `billing_mode` 列（`billed` 默认 / `showcase`），走库内守护式增量（与 `proactive_greeting` 同型，禁裸 ALTER 抛错）；验证：旧库实测补列、旧行默认 `billed`
- [x] 2.2 房间设置面可切换 `billing_mode`，房间详情暴露该字段；验证：PATCH 后 GET 读回、非主办 403
- [x] 2.3 `settle_unbilled` 事件 meta 增 `expected: true|false`（`billing_mode==='showcase'` 为 true）；验证：两间房各造一次无键应答，断言 expected 分别为 true/false
- [x] 2.4 界面文案区分「预期未计费」与「配置缺口」（五语各两条：`settle_unbilled` / `settle_unbilled_expected`）；访客壳 `EVENT_LABEL` 仍不含该键 ⇒ 访客不可见（已实测）；站内房间页按 `meta.expected` 选词条
- [x] 2.5 演示房置为 `showcase`（2026-11-11 01:37 执行，走 store API 不裸改表）：`billed → showcase`，`roomGet` 读回 `showcase`；验证：房间详情可读该字段

## 3. 收尾

- [x] 3.1 上产后复验（2026-11-11 01:37，镜像 `sha-bb34318`，platform `platform-cc58d68b-jrnpp` / facet `facet-5df7fc7cdf-56bvf`）：
  - 代码在容器内实测：platform `billing_mode`=5、`billingMode`=5；facet `NO_BILLING_KEY`=1
  - 触发一次访客作答（guest 点名产品向导）→ 日志出现
    `2026-11-11T01:37:55.003+08:00 [zhiyu] settle unbilled (no billing key, expected: showcase room) … (seq 114)`
    —— 口径是 **expected: showcase room**，不再是 CONFIG GAP
  - 房间多一行 `settle_unbilled`（seq 115），meta 含 `"expected":true`、`code:"NO_BILLING_KEY"`
  - `pack_host_settlements` 保持 **12 行 / zyr- 4 行**不变（降级不是补账）
  - 访客侧不可见：390×844 打开 embed，body 无 `settle_unbilled` / `未计费`
  - 探针已清：7 行 + 2 guest 删除，房尾回 108 / guest 23（备份 `/data/cells/zhiyu-showcase-accept-backup.json`）
- [ ] 3.2 归档本单（含 spec delta 合入 `openspec/specs/zhiyu-room/`）
