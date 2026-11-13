## 1. 对外发言动作与无旁路

- [x] 1.1 `lib/action-registry.js` 新增对外发言动作条目（`risk: write`、`outbound: true`、`contentArgs` 指向正文字段），并纳入 outbound 加载期校验 —— 单测断言条目存在、缺 `contentArgs` 时加载失败
- [x] 1.2 对外发送的凭据只按调用注入：各渠道 `sendText(cred, …)` 按参接收；闸模块自身零 I/O —— `scripts/test-outbound-no-bypass.mjs` 静态断言
- [x] 1.2b `server/bots/wecom.js` 的令牌缓存持有 `cred` —— **已审，判定保留**：`entry.cred = cred` 是有意为之，注释记载它修掉了凭据轮换后仍用旧 secret 取 token 的生产事故（持续 40001）。去掉它需引入「轮换即失效」协议，会让已修的 bug 复现；且它与发送闸无关（发送仍按调用传参）。若将来要改，必须同时补轮换失效的验收。
- [x] 1.3 旁路尝试可记录（`noteBypassAttempt`，永不抛）；并**关闭了一条真实旁路**：`sendTo()` 原本直接调 adapter，不经闸
- [x] 1.3b 旁路记录进同一本越界计数并在摘要可见（「旁路尝试 × N」）—— 记录无域时按「—」归桶：要求必须有域会让最该被看见的一条被静默丢掉
- [x] 1.4 IM 回复走受闸路径 —— `server/bots.js` 的 `replyRaw` 经 `gateAndSend`，bot 用例全绿
- [x] 1.5 cell 侧「取裁决」端点：`POST /api/actions/mandate-verdict`，自带 bearer（常数时间）、未配置 503、异常失败关闭 —— 接口测试覆盖未配置/错令牌/越界/放行四例
- [x] 1.6 runner 侧在 `manager.js` 的 `turn()` 出口取裁决，仅对外车道（声明 mandateDomain）生效；未注入客户端即拒绝发出 —— 单测覆盖装配与失败关闭默认值（真回合出口需真实 child 握手，行为由 6.5 端到端覆盖）
- [x] 1.7 流式与闸不兼容的处置：对外车道禁用 `message/stream`（`-32013`，spawn 前拒绝）—— delta 是边生成边发的，出口闸来不及；缓冲 delta 会毁掉流式，放行会毁掉闸

## 2. 披露判定接原文

- [x] 2.1 校验读取将要发出的原文（`contentArgs`），摘要不参与判定 —— 单测覆盖「正文含金额、摘要不含」判为越界
- [x] 2.2 三类依据可解释（provenance / pattern / term）并返回引用 —— 单测逐类断言命中方式与引用
- [x] 2.3 越界时动作回落 `draft` 且越界项可读、可据此改写重试 —— 集成测试断言回落与越界项内容
- [x] 2.4 连续越界计数进日报 —— 单测断言计数写入与日报条目（「只有被拦记录」的窗口也会产出摘要：沉默不能看起来像健康）

## 3. 台账与检索

- [x] 3.1 `action_audit` 加 `principal` / `audience` 两列（可空）—— 迁移后既有查询不受影响
- [x] 3.2 对外发言写入完整字段（principal/audience/disclose_level/mandate_ref/precedent_refs/content_digest/reversible_until），不写原文 —— 单测断言字段齐全且原文不落库
- [x] 3.3 按 principal、按对象、按披露层级、按可撤销状态四种检索 —— 接口测试各覆盖一例

## 4. 身份口径与回执

- [x] 4.1 同一内容按受众渲染两形态（内部带标注 / 外部不带），共用一份内容与一条台账 —— 单测断言两形态内容一致、台账指向同一行
- [x] 4.2 不因形态不同重复披露判定 —— 单测断言同一内容第二次渲染不再触发判定
- [x] 4.3 溯源回执按台账 id 查询，返回授权人/代理/时间/引用判例 —— 接口测试覆盖存在与不存在两例
- [x] 4.4 回执默认不随消息附带 —— 单测断言外发内容不含声明文本

## 5. 放量闸与撤回

- [x] 5.1 层级样本闸：升对外自动发送需该域一致率达标 + 命中层级样本达标，任一不足即拒绝并指名缺项 —— 接口测试覆盖「层级样本为 0」与「双达标」两例
- [x] 5.2 无反向能力的渠道恒回落 `draft` —— 单测覆盖渠道 `revocable=false` 且配置 `act-silent` 的情形
- [x] 5.3 撤回联动：窗口内走反向路径并留痕；窗口过或渠道不可撤回时拒绝并说明 —— 集成测试覆盖三条终局

## 6. 验收

- [x] 6.1 全量回归：门面 / 动作 / 委托 / 判例 / 审计官既有套件全绿 —— `node --test` 相关用例集零失败
- [x] 6.2 端到端：IM 回复 → 台账行 → 回执 → 窗口内撤回 —— `scripts/test-outbound-gate.mjs` 覆盖台账/回执/撤回三条终局
- [x] 6.3 端到端：对外回复含金额且 `disclose_scope` 不含财务 → 回落 draft 且越界项可读 —— `scripts/test-outbound-gate.mjs` 覆盖（越界项点名 finance/via=pattern）
- [x] 6.4 浏览器冒烟：设置面展示各披露层级的样本量与「缺哪个层级不能开自动发送」 —— `e2e/settings-disclosure-levels.spec.js`（每层都要同时给数字与能否放量；只有总数的话主人知道「还不够」却不知道补哪层）
- [x] 6.5 端到端：`scripts/verify-mandate-acceptance.mjs` 真机跑通 15/15 —— 真 server + 真浏览器：三处设置面有内容、未配置不授权、写读回一致、未知域 400、裁决四条路径（401/越界/放行/不可撤回回落/缺文本 400）、台账读面
- [x] 6.6 失败关闭演练：引擎侧未注入裁决客户端即拒绝发出（单测）+ 服务端异常返回 draft/verdict_error（真机验收中实测：漏 import 时端点返回 draft 而非放行）+ 步骤见 `docs/disclosure-gate-verification.md`
