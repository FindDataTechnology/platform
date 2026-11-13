# declare-zhiyu-keyless-showcase-rooms

## Why

智语里存在一类**本来就不该计费**的房间：对外演示/样机房（`zy_42ce690574b5423bd2`「智语 · 现场演示」就是），席位跑在免费额度上，用来看产品而不是做生意。但 spec 的「计费与配额挂钩」只写了"按部署键计量"与"键不可用则谢绝发言"两种情形，**没有第三种"这房没有键也不算错"**。

于是实现与运维口径都不对：

- 实现侧（本次已落地的启发式降级）：`host-settle` 对无键部署回 409 `NO_BILLING_KEY`，房间落一行 `settle_unbilled`。这是**如实标注**，但读起来像"出问题了"。
- 运维侧：任何人 `grep settle_unbilled` 都会以为演示房在报错、以为是键没配上或权限坏了——而它本来就是免费的。今天我自己就查了三轮才确认这是**正常态**。
- 产品侧：四席（产品向导/壹座专家/识律专家/柏讯专家）公开回答访客提问，一回合按 0.1 美元/分钟计，真实成本存在但**没有任何人有预期**。

缺一条契约，就会有人反复"修"这个不是故障的现象。

## What Changes

- 在 `zhiyu-room` 的「计费与配额挂钩」上补第三种情形：**空间可声明为「展示模式」**（keyless showcase）。展示模式下，未绑定计费键的席位 SHALL 照常应答，其回合 SHALL 记为「未计费」并在空间事件流留痕（`settle_unbilled`），MUST NOT 被视为故障，也 MUST NOT 中断空间其余活动。
- 展示模式 SHALL 是**显式声明**（空间级开关），而不是"没配上键就自动算展示"——后者会把配置事故伪装成正常态。未声明的空间若出现无键席位，SHALL 仍以 `settle_unbilled` 留痕，且该房 SHALL 被视为**配置缺口**（可被巡检点名）。
- 展示模式 SHALL NOT 影响：日预算上限、应答上限、熔断、以及"欠费谢绝"——只是免掉"没有计费键"这一项。
- 展示模式的房间 SHALL 在房间详情/设置面可读出该状态（谁都能看出这房免费跑），MUST NOT 静默。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `zhiyu-room`：「计费与配额挂钩」新增展示模式（keyless showcase）语义与其留痕、巡检口径。

## Impact

- 代码（后续 apply）：`gateway/zhiyu/store.js`（房间级 `billing_mode` 列）、`gateway/zhiyu/index.js`（设置面读写 + 房间详情暴露）、`gateway/zhiyu/room-router.js`（`settle_unbilled` 事件 meta 带 `expected: true|false`）、`web/src/pages/ZhiyuRoomPage.tsx`（设置面开关 + 事件文案区分"预期未计费"与"配置缺口"）。
- 数据：`zy_rooms` 增列（走库内守护式增量，与既有 `proactive_greeting` 同型）；演示房置为展示模式。
- 测试：展示模式下无键席位应答不报错且 `settle_unbilled.expected=true`；未声明房间同情形 `expected=false`（巡检可点名）。
- 不在本单：不补 `deployment_keys`（用户裁决维持）、不改费率、不追溯历史账。
