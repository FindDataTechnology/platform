## ADDED Requirements

### Requirement: v1 方言如实拒绝，不归一化兼容

平台 SHALL 只接受蓝图格式 v2（`boundary` / `dataSources` / `board` / `acceptance` 结构化条目）。收到 v1 方言（出现 `vertical` / `sources` / `boards` 独有键，而对应 v2 键 `boundary` / `dataSources` / `board` 缺位）时，平台 SHALL 落一条指名 v1→v2 的错误并拒绝，SHALL NOT 归一化改写成 v2 形状后接受。

该拒绝 SHALL 分两处生效：
- **写入层**：v1 形状的 content 在任何写路径（创建/编辑，及未来写入方）上结构性不可存储，与「蓝图不含凭据」同级处理——拒绝且不落库。
- **校验链**：校验/批准/铸造入口同样拒绝；且该拒绝 SHALL **短路**后续校验链，只报这一条根因错误，SHALL NOT 叠加由方言错位派生的形状错（如逐条 acceptance 形状错与无字段归属的包级错）。

错误文案 SHALL 指名：本平台只接受 v2、v2 各段字段形状、格式真源位置、以及 v1→v2 的逐项迁移指引（`vertical{name,tagline,non_goals[]}` → `boundary{name,oneLine,outOfScope}`、`sources[].registryName` → `dataSources[].ref`、`boards` → `board`、自由文本断言 → 结构化断言条目）。

这与「未知断言 kind 拒绝而非猜测」同族：错方言必须被如实指名，不得静默猜测或静默转换。

#### Scenario: v1 蓝图写入被指名拒绝

- **WHEN** 主人把一份按 v1 字段名写的蓝图（`vertical` / `sources` / `boards` / 自由文本 `acceptance`）粘贴提交创建或编辑
- **THEN** 请求被拒（422），返回**一条**指名「蓝图格式为 v1，本平台只接受 v2」的错误，含 v2 字段清单与逐项迁移指引；库中不新增/不改写该蓝图

#### Scenario: 校验链只报根因，不报派生散错

- **WHEN** 对一份 v1 形状的蓝图执行校验、批准或铸造
- **THEN** 回报中只有这一条 v1→v2 错误；不出现逐条 `acceptance[N]` 形状错，也不出现无字段归属的包级错误

#### Scenario: v2 蓝图不受影响

- **WHEN** 提交一份按 v2 字段名写的蓝图（含 `boundary` / `dataSources` / `board` / 结构化 `acceptance`）
- **THEN** 创建、校验、批准、铸造全链行为与本变更前一致；即便该文档另带一个无害的旧键也不触发 v1 拒绝（判别要求 v1 独有键存在**且**对应 v2 键缺位）
