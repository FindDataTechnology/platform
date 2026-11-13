# agent-fleet-orchestration Delta — add-fleet-orchestration

## ADDED Requirements

### Requirement: 舰队以 orchestration 声明段描述编导边与约束

舰队对象 SHALL 支持可选 `orchestration` 段:`edges`(边集)与 `constraints`(spanMax / budgetPerEdgeMin / maxChainDepth,均可缺省取默认)。边 SHALL 为四种之一:`trigger`(cron 触发某岗,= 既有节奏物化的图形态,行为不变)、`report`(报数上行,= 既有报数通道,行为不变)、`dispatch`(运行期由岗位发起的派活许可)、`handoff`(上游岗回合完成后接棒下游岗)。每条边 SHALL 显式引用本舰岗位 ref;系统 SHALL NOT 按建队顺序或任何隐式规则推断边。写面 SHALL 全量校验:边引用的岗位存在、handoff 子图无环(有界环属第二波 fanout)、每条 handoff 链长 ≤ maxChainDepth、span ≤ spanMax(警告级)。未声明 orchestration 段或声明为 `schedule` 模式时,系统行为 SHALL 与现状逐字节一致。

#### Scenario: 声明一条流水线

- **WHEN** 舰队声明 handoff 边 抓取→清洗→撰稿 与 trigger 边 cron(0 9 * * *)→抓取
- **THEN** 校验通过,三岗节奏物化照常(清洗/撰稿无节奏物化),每日 9 点抓取回合完成后自动接棒清洗

#### Scenario: 隐式推断被拒

- **WHEN** 声明段留空但期望按建队顺序成链
- **THEN** 不产生任何 handoff 行为;边只有显式声明一种来源

#### Scenario: 环拒绝

- **WHEN** handoff 边构成 A→B→A
- **THEN** 写面结构化拒绝并指名成环边

#### Scenario: 未声明逐字节等价

- **WHEN** 一支未声明 orchestration 的既有舰队在本 change 后运行
- **THEN** 节奏物化、报数、拍板、模型归位、事件流与现状逐字节一致(既有测试套件为等价证明)

### Requirement: dispatch 边使能同舰队岗位间派活

持有 dispatch 许可(显式 dispatch 边或 supervisor/pipeline 模式展开)的岗位回合 SHALL 获得 `dispatch_post` 工具:按岗位 ref 派活给同舰队岗位,brief 为自包含任务说明;派发 SHALL 走既有 delegation 车道创建 manual 任务(证据 `origin.fleet` 指名目标岗、initiator 为派发岗会话),结果 SHALL 异步送达——派发立即返回,目标岗回合摘要经聚合器在派发岗下一回合注入,系统 SHALL NOT 挂起派发回合等待。护栏 SHALL 结构化拒绝:跨舰队目标、自派、目标岗回合深度已达 1、每岗每回合派发超上限(默认 3)、舰队每小时派发超上限(默认 30,均可 env 配置)。派发目标域 SHALL 为 persona、a2a 与 tool 岗(cluster 岗无 manual 车道,SHALL 结构化拒绝)。派发与被派发回合 SHALL 经既有回合收口自动产出 O1 事件,不新增记录路径。

#### Scenario: 主管派活闭环

- **WHEN** supervisor 模式下主管岗回合内 dispatch_post(执行岗 ref, brief)
- **THEN** 执行岗起 manual 回合,brief 含派发者身份;派发岗本回合继续收尾,下回合收到执行岗回合摘要

#### Scenario: 护栏拒绝面

- **WHEN** 派发目标在另一舰队、或目标为本岗、或目标回合深度已 1、或超频次上限
- **THEN** 工具以结构化错误拒绝并指明原因,不创建任务

### Requirement: handoff 边在上游回合完成后接棒下游

上游岗回合结束(成功或失败均如实)时,系统 SHALL 在回合收口处检查该岗出边:每条 handoff 边 SHALL 为下游岗创建 manual 回合(persona、a2a 与 tool 岗可达;cluster 岗无 manual 车道,跳过),证据 `origin.fleet` 指名下游岗,深度按链位递增且不超过声明链长,每跳时长上限取 budgetPerEdgeMin;整链 SHALL 逐跳产出 O1 事件,链上各跳花费合计记入发起回合的证据链。上游失败时下游 SHALL 照常接棒并收到失败上下文(如实转述,不自动重试)。

#### Scenario: 链式接棒

- **WHEN** 抓取岗回合成功结束且有 handoff 边至清洗岗
- **THEN** 清洗岗自动起回合,brief 含上游产出引用与链位;两跳各产一条 O1 事件

#### Scenario: 上游失败如实接棒

- **WHEN** 抓取岗回合失败(errorKind=model_upstream)
- **THEN** 清洗岗照常接棒,brief 含上游失败摘要;不重试、不吞错

#### Scenario: 链深守界

- **WHEN** 递增后的链位将超过声明 maxChainDepth
- **THEN** 不创建下游回合,以结构化事件记录越界拒绝
