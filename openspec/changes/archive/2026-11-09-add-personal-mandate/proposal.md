## Why

平台已能把 AI 委派成「常务岗」替主人在**舰队内部拍板队列**上裁决（`agent-fleet-decision-delegate`，在产），也有针对单个动作的确认闸（`action-gate`，在产）。但这两者之间缺一层**授权状**：主人无法表达「报价这件事你可以先答后报，交期这件事必须先问我，金额超过 5 万必须问，而且不许对外提未公开的客户名」。

现状的具体症状：

- 委托策略只有一维 `routes{类别→owner|deputy}` + `maxSeverity` + `dailyBudget`（`server/routes/fleets-db.js:1913-1966`），无法按域、按动作类、按额度表达；
- `action-gate` 的确认档位由**动作的风险等级**决定，是全局的——同一个「发送消息」动作，对运营播报该自动执行，对客户承诺就该二次确认，今天只能一刀切；
- 「能读什么」和「能说出去什么」没有区分：agent 能读到全部记忆，也就意味着它有能力把不该外传的内容说出去，出站无强制的披露校验；
- 代理以主人名义做出的动作有一半没有归属账（拍板有 `resolved_by`，对外发言没有）。

这使得「个人代理代表人做决策和回答问题」这件事只能靠提示词约束，而平台在 deputy 上已经确立的原则是**信任由服务端强制，不靠提示词**（`fleets.js:2110-2160` 逐项 403/429）。

## What Changes

- **新对象：委托状（Mandate）** —— 按「域」组织的三维授权，作为 `action-gate` 之上的策略层：
  - **决策模式**：`advise`（只给判断）/ `draft`（起草待发）/ `act-notify`（先做后报）/ `act-silent`（自主，仅日报）；
  - **动作范围**：对动作注册表里的动作按域给出模式覆写 + 额度上限（金额/条数）+ 有效期 + 撤销窗口；
  - **知情范围**：`read_scope`（能读哪些记忆层与语料）与 `disclose_scope`（对外能说到第几层）**分列两个闸**。
- **确认档位可被委托状覆写，但有硬上界**：委托状只能把确认档位**下调到注册表风险允许的下限之内**，且 `destructive` / `publish` 两类存在不可降级集合（对外发布、删除、签署）。越界仍走既有档位。
- **披露闸挂在出站路径的 preflight**：凡发送/发布类动作，执行前按 `disclose_scope` 校验内容与目标，越界即拦截并附越界项，**不是**提示词提醒。
- **代理动作台账**：受委托状驱动的执行记录除既有审计字段外，携带 `mandate_ref`、`domain`、`mode`、`disclose_level`、`reversible_until`；对外发言类记录额外保存内容摘要与目标。
- **默认不放大**：未配置的域一律回落 `advise`；存量委托策略迁移为单一 `ops` 域，语义与今天逐字节等价——上线不新增任何自主权限。
- **设置面**：主人可配置每域的三维取值、额度与期限，并查看「本域最近由代理驱动的动作」清单。

**不做**（各自有承接）：个人事务域的接入与判例读取（`widen-deputy-to-personal-domains`）；对外身份口径切换与溯源回执（`add-principal-disclosure-gate`，本 change 只立 `disclose_scope` 字段与强制闸骨架）；代理自身裁决作为判例（明确禁止，见 design）。

## Capabilities

### New Capabilities

- `agent-personal-mandate`：个人委托状——三维授权模型（决策模式/动作范围/知情与披露范围）、按域路由与覆写规则、额度有效期与撤销窗口、默认不放大的迁移语义、披露闸的出站强制与越界拦截、代理驱动动作的归属台账与设置面。

### Modified Capabilities

- `action-gate`：确认档位在保留风险上界与不可降级集合的前提下，可由委托状按域覆写；受委托状驱动的执行记录携带 mandate 引用与可逆窗口。
- `agent-fleet-decision-delegate`：委托策略从单维 `routes/maxSeverity/dailyBudget` 扩展为 `domains[]` 结构（`ops` 域承载原字段），并规定存量配置的迁移与未配置域的回落语义。

## Impact

- **代码**：`lib/action-registry.js`（动作条目的域归属与可降级标记）、`lib/action-executor.js` / `server/actions-mcp.js`（执行前读委托状、写 mandate 引用）、`lib/action-preflight.js`（披露闸钩子）、新增 `lib/personal-mandate.js`（三维模型、归一化、校验、迁移）、`server/routes/fleets-db.js:1913-1966`（policy schema 扩展与迁移）、`server/routes/fleets.js:2110-2160`（授权闸读新结构，保持既有错误码语义）。
- **数据**：`fleets.delegation_policy` 与 `cell_settings['delegationPolicy']` 的 JSON 结构升级（向后兼容读，写入即新结构）；动作审计表新增 `mandate_ref / domain / mode / disclose_level / reversible_until` 列。
- **API**：委托状读写面（cell 默认 + 舰队覆写，沿用既有路径）；设置面所需的「本域代理动作清单」读面。
- **兼容性**：存量策略在首次读取时惰性迁移为 `domains:[{domain:'ops',...原字段}]`，不做一次性批改；未配置域回落 `advise`。既有 403/429 错误文案与语义不变。
- **测试**：既有委托裁决合同（首裁定局/越权拒绝/日预算）全量回归须绿；新增三维归一化、迁移等价性、披露越界拦截、不可降级动作集、默认回落共五组。
- **风险边界**：这是一次「授权面」的扩展，任何默认值放大都等于一次性放开权限。设计的默认值纪律是**不放大**，且 `destructive`/`publish` 的不可降级集合须硬编码、不可经设置面关闭。
