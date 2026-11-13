## MODIFIED Requirements

### Requirement: 主人可配置委托策略

系统 SHALL 提供委托策略的配置面：cell 级默认 + 舰队级覆写。策略 SHALL 以域（domain）为组织单位，`ops` 域 SHALL 承载既有的舰队内部委托语义：按类别的路由（例行运营、问题单、配置改动、人事、花费 → owner 或 deputy）、可委托的最高严重度、deputy 每日裁决预算、裁决所用模型、汇报摘要频率。`config-change`、人事、花费三类在本域内 SHALL NOT 可配置为委托——它们永远路由 owner。策略变更 SHALL 即时生效于后续路由，SHALL NOT 追溯改写已路由条目。

策略结构 SHALL 允许多域并存，每个域按 `agent-personal-mandate` 的委托状维度声明决策模式、动作范围与知情范围；未声明或未升级的域 SHALL 回落 `advise`，MUST NOT 继承 `ops` 域的路由结论。

存量策略 SHALL 惰性迁移为单一 `ops` 域：读取时兼容扁平旧结构，写入时落多域结构；迁移 SHALL NOT 改变既有路由结果与裁决预算语义。

#### Scenario: 主人把例行运营委托给常务岗

- **WHEN** 主人在设置面把 `ops` 域的「例行运营」类别路由为 deputy 并保存
- **THEN** 此后该类别的新拍板项在创建时即路由 deputy，不再计入主人角标

#### Scenario: 高风险类别不可委托

- **WHEN** 主人尝试把 `ops` 域的「花费」类别路由为 deputy
- **THEN** 设置面拒绝该配置并说明该类别在 `ops` 域永远路由 owner

#### Scenario: 舰队覆写关闭委托

- **WHEN** 某舰队覆写 `ops` 域的 delegation.enabled=false
- **THEN** 该舰队所有新拍板项路由 owner，行为与未启用委托前一致

#### Scenario: 未声明域不继承 ops 路由

- **WHEN** 主人只配置了 `ops` 域，一条属于其他域的事项进入委托判断
- **THEN** 该域按 `advise` 处理，不套用 `ops` 域的 routes 或预算

#### Scenario: 存量策略迁移后语义不变

- **WHEN** 一个使用扁平旧策略 `{routes, maxSeverity, dailyBudget}` 的舰队升级后触发一次裁决
- **THEN** 该配置被读作 `ops` 域并产生与升级前相同的放行或拒绝结果
