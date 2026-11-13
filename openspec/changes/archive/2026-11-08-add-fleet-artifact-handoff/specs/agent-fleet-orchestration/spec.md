## MODIFIED Requirements

### Requirement: handoff 边在上游回合完成后接棒下游

上游岗回合结束(成功或失败均如实)时,系统 SHALL 在回合收口处检查该岗出边:每条 handoff 边 SHALL 为下游岗创建 manual 回合(persona、a2a 与 tool 岗可达;cluster 岗无 manual 车道,跳过),证据 `origin.fleet` 指名下游岗,深度按链位递增且不超过声明链长,每跳时长上限取 budgetPerEdgeMin;整链 SHALL 逐跳产出 O1 事件,链上各跳花费合计记入发起回合的证据链。上游失败时下游 SHALL 照常接棒并收到失败上下文(如实转述,不自动重试)。

上游回合 SHALL 把其**产出的可寻址产物句柄**随边下传：系统 SHALL 在点火时读取上游回合产出的资源库条目
（以该回合的会话与起止窗口界定，取最近若干条），并在下游 prompt 中 SHALL 以「资源库标识 + workspace 相对路径」
的形式列出，且 SHALL 明确指示下游直接取用而不要重新生成。产物段 SHALL 排在既有散文转述之后、
上下文占位符之前；上游未产出任何产物、或资源库不可读时，SHALL 整段缺席且 prompt 其余部分逐字节不变
（降级放行，绝不因产物读取失败而阻断接棒）。产物句柄 SHALL 仅下发给 persona 目标：a2a 目标是另一服务
（资源库标识对其无意义），tool 目标的 prompt 必为纯 JSON 参数。

#### Scenario: 链式接棒

- **WHEN** 抓取岗回合成功结束且有 handoff 边至清洗岗
- **THEN** 清洗岗自动起回合,brief 含上游产出引用与链位;两跳各产一条 O1 事件

#### Scenario: 上游失败如实接棒

- **WHEN** 抓取岗回合失败(errorKind=model_upstream)
- **THEN** 清洗岗照常接棒,brief 含上游失败摘要;不重试、不吞错

#### Scenario: 链深守界

- **WHEN** 递增后的链位将超过声明 maxChainDepth
- **THEN** 不创建下游回合,以结构化事件记录越界拒绝

#### Scenario: 接棒拿到上游产物句柄

- **WHEN** 上游回合产出了「季度图表.json」（资源库条目 + workspace 路径），其 handoff 边点火 persona 下游
- **THEN** 下游 prompt 含「上游产物」段，列出该条目的资源库标识与 workspace 相对路径，并指示直接取用
- **AND** 散文转述仍在产物段之前，上下文占位符仍在最后

#### Scenario: 上游无产物则零变化

- **WHEN** 上游回合没有产出任何资源库条目
- **THEN** 下游 prompt 不含产物段，与引入本条款前逐字节一致

#### Scenario: 只给 persona

- **WHEN** 同一波上游产物下发到 a2a 目标或 tool 目标
- **THEN** a2a 的 prompt 不含产物段；tool 的 prompt 仍是纯 JSON 参数

#### Scenario: 扇出每个 persona 目标都拿到

- **WHEN** 扇出波有多个 persona 目标
- **THEN** 每个目标的 prompt 都含同一份产物段

#### Scenario: 资源库不可读不阻断

- **WHEN** 资源库未就绪或读取抛错
- **THEN** 产物段缺席，接棒照常点火，SHALL NOT 因此失败

