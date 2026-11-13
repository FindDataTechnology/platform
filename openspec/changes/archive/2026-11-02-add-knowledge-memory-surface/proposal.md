# Proposal: add-knowledge-memory-surface

## Why

知识库的 agent 主动调用面已经存在（`document-library-tools`：list/search/read/fetch 四枚 MCP 工具挂 chat lane），但智能体团队的回合车道与智语房间的部署成员拿不到它——**团队用不上知识库**。永忆一侧 L0→L2 分层、tier 晋升、digest 注入都在产，展示却只有平铺列表，用户看不懂能力边界。姊妹 change `add-web-project-container` 提供了归属键（project），检索边界与"用知识库做 agent"的产品化此刻才有落点。本 change 优化两系统的使用（挂进团队/房间车道 + 蓝图钉库）与展示（nav 归族折叠 + 记忆蒸馏视图 + 集合直链造 agent）。

## What Changes

- **A1 车道覆盖**：library MCP 工具挂进 fleet 执行回合与智语一键召唤的部署成员，挂载走 execution 侧唯一汇合点（注入缝唯一化教训：横切关注点不进 enqueue 侧），供给门复用 dsh 白名单建制（browser-mcp 先例）。检索边界 = 当前 project 的 collections ∪ shared；游客/匿名 embed 车道不得获得 library 工具。
- **A2 用知识库做 agent**：蓝图 `dataSources` 可引用知识库 collection（构造间提供选库 UI）；实化后的成员按钉上的 collection 获得限定检索 = 「KB 型岗位」。铸造→实化→上架全走现成流水线，不新增部署机制。
- **D1 nav 归族**：web 左侧导航按族折叠/展开（Codex 式），「知识」族收纳 知识库/成果/永忆 三枚，「构建」族收纳 智能体团队/蓝图构造间（compose→materialize 成对相邻），nav 仍由 surface registry 驱动，族是展示层元数据；预设（FACTORY_PRESETS）与谓词（adminOnly/desktopOnly）兼容。
- **D2 记忆面板升级**：owner u/ 浏览面从平铺列表升级为蒸馏漏斗视图——L0→L1→L2 流量与占比可见、tier 分布、晋升提议箱（已在产的 accept/ignore）升为第一区块、条目源跳转沿用现链；筛选语义与降级态条款不变。
- **D3 集合直链**：collection 卡片提供「用它造 agent」动作，深链蓝图构造间并预填 `dataSources`；聊天侧交接文案不变。

**非目标（明确排除）**：引用反查（"这份资料被谁用过"的观测面）、团队/房间/产出的 Project 归属（容器扩大的后续刀）、跨团队知识共享 ACL、萬星 console 部署者浏览面改版（其读取面已在产）。

## Capabilities

### New Capabilities

- `sidebar-nav-families`: web 导航的族归组与折叠展开契约——族成员、折叠态持久化、与 surface registry/预设/谓词的兼容、当前项永远可见的不变式。

### Modified Capabilities

- `document-library-tools`: 车道覆盖从 chat 扩至 fleet 回合与智语部署成员；新增按 project 的检索边界条款与游客车道排除条款。
- `fleet-blueprint-studio`: `dataSources` 合法引用面扩展——知识库 collection 成为可选数据源，实化成员获得限定库访问。
- `memory-portal-ui`: 壹座 web 面板的展示需求升级为漏斗优先布局（分层流量、晋升箱第一区块），筛选/降级/写回条款保留。
- `document-collections`: 集合卡片新增「用它造 agent」交活动作（深链 + 预填），保存态行为不变。

## Impact

- 服务端：fleet 执行链的 mcp 供给（cell 车道 mcp.json 生成处）、`server/library-mcp.js` 边界参数（project/shared 过滤）、蓝图校验（dataSources 接受 collection 引用）。
- Web：`Sidebar.tsx`（nav 族）、`MemoryPage.tsx`（漏斗视图）、`DocumentsPage.tsx`（造 agent 直链）、`BlueprintStudioPage.tsx`（选库 UI）。
- 依赖：`add-web-project-container` 先行（project 键是检索边界与漏斗分组的前提）。
- 不动：永忆存储层与 distiller 契约、铸造/实化/上架流水线、智语房间协议本身。
- 词汇：族名与动作文案走终词（「知识」族、「永忆」保留品牌词），新键不翻旧键。
