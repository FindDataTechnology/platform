# pack-bot-units Specification

## Purpose
bot 作为 pack 的第三原语（与内联技能、MCP 引用并列）：pack 以「通用 bot 类型 + 可选挂载一个 pack 内技能」声明处理简单功能的轻量 bot 单元，安装物化为 cell 的 bot 实例——既能独立应答（像挂了技能的通道助手），也能作为舰队的 bot 岗位与事件源，让一个 pack 开出会干活也会说话的完整编制。

## Requirements

### Requirement: bots 段是 pack 第三内容原语

pack manifest SHALL 支持可选 `bots` 段，每条声明：bot id（作者起名，规则同 agent id）、显示名、通用 bot 类型引用、描述、可选的技能挂载（SHALL 引用本 pack 内声明的技能名，每 bot 至多挂一个）。`bots` 条目 SHALL NOT 携带凭据、令牌、端点或任何通道密钥材料——通道凭据归 cell 运营者配置（与 MCP 引用不自带端点同一哲学）。单 pack 的 bots 条目数 SHALL 有上限，上限为运营策略（环境可调），非结构常量。含非法 bots 段（未知键、id 非法、挂载引用不存在的 pack 技能、携带禁键）的 manifest SHALL 在发布预校验与安装校验两处以同源规则拒绝。

#### Scenario: 合法 bots 段过预校验

- **WHEN** 一份 manifest 声明 `bots: [{ id: "desk-greeter", name: "前台应答", generic: "channel", skill: "desk-greeting", description: "..." }]` 且 `desk-greeting` 在同 pack skills 段内
- **THEN** 发布预校验与安装校验均通过

#### Scenario: 挂载引用不存在的技能被拒

- **WHEN** bots 条目的 skill 挂载引用的技能名不在本 pack 的 skills 段
- **THEN** 预校验以结构化错误拒绝并指名该 bot id 与缺失技能名

#### Scenario: 携带凭据材料被拒

- **WHEN** bots 条目出现 token、secret、apiKey、endpoint 等禁键
- **THEN** 预校验以结构化错误拒绝并列出禁键

### Requirement: 通用 bot 类型面

平台 SHALL 定义并托管通用 bot 类型集——预置的简单功能模板，pack 按类型名引用（pack 不能自带 bot 实现）。v1 类型集 SHALL 至少含 `channel`（通道收发：出站投递消息 + 入站作为事件源；挂载技能后入站消息先经技能会话作答）。类型清单 SHALL 有只读面（发布预校验、cell 安装面、目录面同源）。引用未定义类型的 bots 条目 SHALL 在发布预校验拒绝。

#### Scenario: channel bot 挂技能独立应答

- **WHEN** 装有 `desk-greeter`（generic: channel，挂 desk-greeting 技能）的 cell 完成通道凭据配置后，外部用户经该通道发来一条消息
- **THEN** bot 以技能会话作答（技能的流程与诚实约束管辖该应答），不依赖任何舰队

#### Scenario: 未知类型被拒

- **WHEN** bots 条目声明 generic: "scheduler-x" 而平台未定义该类型
- **THEN** 发布预校验拒绝并指名该类型不在通用类型集内

### Requirement: 安装物化与冲突策略

安装携带 bots 段的 pack 时，每条 bot SHALL 物化为 cell 的 bot 实例（进入既有 bot 存储与目录 bot 面）。物化 SHALL 沿用 pack 的单向不覆写外来内容策略：bot id 被其他已装 pack 或本 cell 既有 bot 占用时 SHALL 跳过并在安装报告带原因；本 pack 自有 id 在升级时替换。通道凭据未配置时该 bot SHALL 以待连接态存在并出现在安装报告，SHALL NOT 使整包安装失败。卸载 SHALL 只删除 pack 自有的 bot 实例，运营者配置的通道凭据与平台 bot 配置 SHALL 保留。

#### Scenario: 装包出 bot

- **WHEN** 用户安装含 bots 段的 pack 且无 id 冲突
- **THEN** bot 实例建立并以待连接态出现在安装报告，配置通道凭据后即可用

#### Scenario: id 冲突跳过

- **WHEN** bots 条目的 id 已被另一已装 pack 占用
- **THEN** 该条目跳过、安装报告指名占用方，其余内容照常安装

#### Scenario: 卸载边界

- **WHEN** 用户卸载该 pack
- **THEN** pack 自有 bot 实例删除；运营者配置的通道凭据不被清除（可被其他 bot 复用）

### Requirement: 舰队衔接

舰队模板的成员目标 SHALL 支持 `bot` 类别：引用本 pack 的 bot（实例化时随包落地）或 cell 既有 bot；目标缺位（pack 未装该 bot、bot 实例不存在）SHALL 按既有待补岗降级。编排 event 边的 `bot:<botId>` 外部信号源 SHALL 对 pack 物化的 bot 与运营者配置的 bot 无差别；bot 岗位无节奏声明时 SHALL 可作为纯被动岗（仅由 event 边或 dispatch 唤醒）。

#### Scenario: pack bot 作为事件源

- **WHEN** 一支舰队声明 event 边 from="bot:desk-greeter" to=客服岗，且 desk-greeter 来自已装 pack 并完成通道配置
- **THEN** 该 bot 的入站消息按既有 bot 唤醒语义创建客服岗 manual 回合，与运营者配置的 bot 行为无差别

#### Scenario: bot 岗位纯被动

- **WHEN** 舰队模板声明一个 bot 成员且不带节奏
- **THEN** 该岗位无物化定时任务，仅被 event 边或 dispatch 唤醒
