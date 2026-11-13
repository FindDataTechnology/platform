## ADDED Requirements

### Requirement: Fleet unattended chains are minted under dedicated service accounts

舰队无人值守 cell 的 wire-customer 链，其 mint 授权主体 SHALL 使用舰队专属服务账号（非人类测试账号）；凭据行的键 SHALL 保持 cell 属主的平台身份（profile 选行语义不变）。即两层身份各司其职：计费/授权归因随 token 主体落服务客户，行键与 cell 归属不因切换而迁移。服务账号 SHALL NOT 用于任何人工交互式登录；除周期重铸机制外任何方改动其口令/禁用位都等价于舰队链全灭。重铸 SHALL 每次使用全新浏览器会话（同会话再授权杀旧链）；以服务账号登录的重铸请求 SHALL 携带工具类 UA（非浏览器 UA），与 wire 侧护栏的告警分类不冲突。

周期重铸机制 SHALL 每轮检查无条件重铸全部在册无人值守行——新授权原子落同一行替换旧链，无服务中断——SHALL NOT 采用「距到期小于固定窗口才触发」类条件：铸币发生在检查相位之间时，任何固定触发窗都存在盖不住绝对租约到点的相位漏洞。

#### Scenario: 切换重铸只动主体不动行键

- **WHEN** 以服务账号完成一次 fleet cell wire-customer 行的重铸
- **THEN** 行键仍为 cell 属主邮箱、cell profile 正常选中新凭据；行内 token 主体=服务账号、stale=0、含 refresh token；上游 grant/billing 归因=服务客户

#### Scenario: 中途铸币的相位也被覆盖

- **WHEN** 某行的铸币时刻不与周期检查点对齐（如切换当日的临时重铸）
- **THEN** 下一轮周期检查仍无条件重铸该行，行龄恒 ≤ 检查周期，绝不跨过绝对租约到点；无「墙后等下轮救回」的空窗

#### Scenario: 重铸登录不触发护栏告警

- **WHEN** 周期重铸以服务账号口令完成一次交互式登录
- **THEN** 该登录携带工具类 UA，wire 侧护栏归为「记录不告警」；人工浏览器登录同账号时护栏按设计告警
