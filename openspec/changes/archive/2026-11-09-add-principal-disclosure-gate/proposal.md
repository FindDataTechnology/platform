## Why

`add-personal-mandate` 让代理知道「这个域里能自主到哪一步」，`widen-deputy-to-personal-domains` 让真实事项进来并能被审计。但两者都停在**对内**：所有对外动作的最高档是 `draft`——代理写好，你自己发。

Lane B 是把它推到最后一步：**代理直接替你跟外部说话**。这一步的阻力不是技术，是三条今天不存在的东西：

1. **披露闸读不到真正的内容。** `disclose_scope` 已能拦「金额/人事/未公开计划」，但它只认识注册表里 `contentArgs` 声明的字段。对外发言走的是门面应答与 IM 回复两条链，它们不在动作注册表里，闸看不见——等于对外发送没有披露校验。
2. **没有「以我名义说过什么」的账。** 台账记的是「执行了什么动作」，不记「说了什么话、对谁说的、当时授权是什么」。出错时无法定位、无法追认、无法撤回。
3. **身份口径无处表达。** 你的要求是「内部显式是代理、外部拟人」，今天门面只有一种身份（接待 agent），没有「同一段话，对内标注、对外不标注」的机制，也没有事后可查的溯源回执。

外加一个不可逆风险：Lane A 的错误可以 reopen，对外说错的话收不回。所以这个 change 的第一原则是**可追溯优先于可用性**。

## What Changes

- **对外发言走受闸路径**：门面应答与 IM 回复 SHALL 在发送前经过与 `action-gate` 同一条执行路径的披露校验，MUST NOT 存在「直接发送」旁路。未声明 `contentArgs` 的对外发言入口 SHALL 加载即失败（与 `action-gate` 的 fail-closed 同款）。
- **披露闸读取真实内容**：校验对象是**将要发出的原文**，不是摘要；来源声明（agent 用了哪些记忆/判例）与文本模式（金额、配置的敏感词）共同判定层级。
- **对外发言台账**：每次发言 SHALL 记 `principal`（代表谁）、`disclose_level`（命中层级）、`mandate_ref`（授权引用）、`precedent_refs`、`audience`（对象与渠道）、`content_digest`、`reversible_until`。内容本身 SHALL NOT 落库。
- **身份口径切换**：同一段发言按受众渲染两种形态——内部受众带「代理」标注，外部受众不标注；两种形态共用同一份内容与同一条授权。
- **溯源回执**：外部受众 SHALL 能在事后（而非每条都带）查到「这句话是某人在某授权下由代理发出的」。回执是可查的，不是每条消息里的声明——后者会毁掉拟人体验，这个取舍必须显式。
- **放量闸扩展**：从 `draft` 升到对外自动发送，除一致率外 SHALL 额外要求该披露层级的样本量达到阈值；不足即拒绝并返回缺少的层级。
- **撤回联动**：对外发言在撤销窗口内的撤回 SHALL 走与动作闸相同的反向路径；无反向能力的渠道 SHALL NOT 支持自动发送。

**范围（实施期两次纠正后）**：两条链都在本仓，因此不拆分。

- **IM 出站**（`server/bots.js`）：同进程、有 cell DB，判定本地算。
- **门面/A2A 应答**（`agent-runner/manager.js` 的 `turn()` 出口）：跨进程、无 cell DB，需向 cell 取裁决，取不到即不发（失败关闭）。

纠正记录：① 应答代码不在别的仓，`agent-runner/a2a.js` 的 `message/send` 就是那句话的出生点；② `turn()` 是所有回合的唯一收口，拆成两个 change 会把同一份契约写两遍。

**不做**：声音/电话外呼；跨委托人代理（一个代理代表多个主人）；披露层级的用户自定义枚举（先固定五档，等真实用法再收敛）；门面语料的自动更新节奏。

## Capabilities

### New Capabilities

- `principal-disclosure-accountability`：对外发言的可追溯面——披露校验的强制接入与无旁路、原文级判定、发言台账（含 principal/mandate/precedent/audience）、内外部身份口径切换、事后溯源回执、按披露层级计的放量闸、撤回联动。

### Modified Capabilities

- `principal-facade`：门面接待应答 SHALL 经披露闸并写入发言台账；身份口径按受众区分；入口 SHALL 提供溯源回执查询面。
- `agent-personal-mandate`：`act-notify` / `act-silent` 在对外渠道上的启用条件增加「该披露层级的样本量达标」；无反向能力的渠道 SHALL NOT 进入自动发送。

## Impact

- **代码**：`lib/personal-mandate.js`（披露判定接入发言路径、层级样本闸）、`lib/action-preflight.js`（对外发言作为受闸动作注册）、`lib/action-registry.js`（新增对外发言动作条目与 `contentArgs`/`outbound`）、`server/routes/actions.js`（发言台账写入与溯源查询）、门面应答链（`principal-facade` 的接待面）与 IM 回复链（`server/bots.js`）统一挂到受闸路径。
- **数据**：发言台账复用 `action_audit` 的 mandate 列，新增 `audience`（对象+渠道）与 `principal` 两列；内容只存 digest。
- **契约**：门面应答的响应形状增加 `disclosure` 字段（层级与回执 id），既有字段不变。
- **测试**：既有门面/动作/委托全套必须继续全绿；新增无旁路证明（绕过执行路径的发送必须失败）、原文判定、台账字段完整性、双形态身份口径、层级样本闸、撤回归档六组。
- **风险**：拟人化对外不可逆——所有设计取舍偏向「可追溯」而非「流畅」；披露误拦会让代理看起来不可用，需要越界项可读、可改写重试；台账只存 digest 意味着争议时需要保留原文的渠道副本。
