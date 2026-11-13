# erp-confirm-gate-mobile Spec

## Purpose

确认门「提交→服务器确认→拒绝回显→超时兜底」在壹座 miniapp 底座上的组件化契约：以 cron 页既有交互模式（`paas/miniapp/src/pages/cron/index.tsx`）为模式源、`QuestionCard.tsx` 为组件同构参照，抽为通用确认门组件，供 ERP 四套页面集全部 confirmGate 页面（UE 2 / SE 2 / SP 2 / CP 2，共 8 页）复用。移动端拍板 = 账本内核 proposal 面的 confirm/reject 席位（与 owner 席位同源），失败/超时不假报成功。

## ADDED Requirements

### Requirement: 确认门四段式为唯一拍板交互

ERP 页面集的全部确认门交互 SHALL 走通用确认门组件的四段式：提交（进入 pending，禁重复提交）→ 服务器确认（成功态呈现）→ 拒绝回显（服务端可解释 message 原样呈现，如信用不足附占用明细）→ 超时兜底（固定时限无回执时回显兜底文案并允许重试）。确认门页面 MUST NOT 采用乐观关闭（提交即视为成功）的交互；超时/失败 MUST NOT 假报成功。cron 既有页 SHALL 改用同一组件且行为回归不变。

#### Scenario: 提交后等待服务器确认

- **WHEN** 用户在任一确认门页面（如 `ue-order-create` 下单）提交
- **THEN** 表单保持打开并进入 pending 态（按钮禁重复提交），直到服务器确认或拒绝回执到达

#### Scenario: 服务端拒绝可解释回显

- **WHEN** 服务器对提交返回拒绝（如信用额度不足）
- **THEN** 页面回显拒绝原因及其解释明细，表单字段保留，用户可修正后重试

#### Scenario: 超时兜底不假报成功

- **WHEN** 提交后在固定时限内既无确认也无拒绝回执（含 WS 断连）
- **THEN** 页面回显超时兜底文案并退出 pending 态，MUST NOT 出现任何成功态呈现

### Requirement: 拍板席位同源生效

移动端 confirm/reject SHALL 作为账本内核 proposal 面的 confirm/reject 席位生效（与 owner 席位同源、先到先得语义沿底座 `answer_question` 契约），经底座 WS 通道提交，MUST NOT 另开 WS 面或平行审批通道；移动端拍板结果与 web/桌面端同源可查。

#### Scenario: 移动端拍板与其他端同源

- **WHEN** 用户在移动端对一条 proposal 执行 confirm
- **THEN** 该决议经底座 WS 通道进入账本 proposal 面并生效，web/桌面端同一 proposal 状态一致

#### Scenario: 多端先答先得

- **WHEN** 移动端与另一端先后对同一 proposal 拍板
- **THEN** 先到者生效，后到者收到已决议的可解释回执，不产生重复执行
