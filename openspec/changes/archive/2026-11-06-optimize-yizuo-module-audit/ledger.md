# 壹座 253 spec 模块总账（optimize-yizuo-module-audit）

> 评级由各簇健康卡回填（A/A-/B/B+/C/D）。簇归属按前缀规则初判，错判在 findings 里点名。
> **评级分布（253 条）**：A×107、A-×120、B×17、B+×4、C×4、D×1——C/D 合计 2.0%（D：e2e-testing；C：cron-module、vertical-packs、chat-input-focus、caller-preferences）

## 簇 A — agent 核心面（18）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| agent-catalog | 14 | A- |  |
| agent-cluster-core | 5 | A- | Defines the cluster abstraction that unifies packs, agents,  |
| agent-delegation-a2a | 4 | A- | The cross-agent delegation domain: a cell's persona delegate |
| agent-delegation-tools | 6 | A | Every persona can delegate work to other personas from the c |
| agent-document | 6 | A- | The single composition model the platform builds, displays,  |
| agent-fork-lineage | 5 | A | Learn-and-remix for the agent ecosystem: any agent a user ca |
| agent-preset-selection | 5 | A- |  |
| agent-residency | 5 | A | The resident lifecycle domain for deployed Agent Services: a |
| agent-scheduling-tools | 6 | A | Defines how agents create and manage scheduled tasks themsel |
| agent-self-iteration | 3 | A- | 自迭代闭环面：agent 用记忆章程声明自己记什么（自定义长期记忆），平台把台账/周报的异常自动转成 |
| agent-service-config | 5 | A- |  |
| agent-spec-sheet | 5 | A | One shared presentation contract for an agent: persona, skil |
| agent-teams-management | 3 | A |  |
| agent-teams-overview | 8 | A |  |
| agent-turn-contract | 3 | A | 一次回合的显式契约:以纯函数从任务引擎记录派生 turnRequest(source/targetRef/brief/e |
| agent-turn-mandate | 4 | A | 事件来源回合请求的授权链：让「谁有权让智能体开工」成为显式、不可变、可审计的记录。以强度与准入表描述授权依据，以影子档（ |
| agent-turn-metering | 3 | A | 定时车道回合的细粒度计量面：每一回合的身份维度、token 细分与时相三段随回合结果事件同缝落列， |
| agent-turn-pricing | 3 | A | 回合计费的估算与对账面：模型单价从词元（唯一计费真源）的管理门读取、进程内缓存、按回合时刻 |

## 簇 B — 舰队与运行（20）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| agent-fleet-architect | 3 | A | 壹座聊天内的舰队自然语言编排面:一个持有舰队读写工具的「架构师」角色,把用户的自然语言编译为舰队 spec 草稿,经 d |
| agent-fleet-carrier | 4 | A | 舰队岗位的承载配置面：每个岗位跑在哪种身体上（cell 主链 / cell worker 槽 / runner 远端）成 |
| agent-fleet-cockpit | 17 | A | 舰队的主人视角投影：把岗位/报数/拍板/健康四路既有读面聚合为一张驾驶舱——组织图与 KPI 卡墙呈现「公司在运转」，拍 |
| agent-fleet-cockpit-projection | 5 | A- | 萬星半边的舰队投影：cell 把主人视角下的全部舰队快照压缩为一个有界聚合端点 |
| agent-fleet-core | 26 | A | 把「舰队」立为 cell 的一等公民：一组按组织树编排的稳定岗位（Member），每个岗位绑定一个可替换的执行目标（pe |
| agent-fleet-decision-delegate | 6 | A- |  |
| agent-fleet-decision-lane | 6 | A- | 舰队的指令边：成员岗位在自治回合中以结构化工具提交待拍板项（问题+选项+严重度+截止），落人批队列；舰队主人批复/驳回/ |
| agent-fleet-orchestration | 5 | A- | 编导代数第一波:舰队以显式 orchestration 声明段描述边(trigger/dispatch/handoff/ |
| agent-fleet-report-lane | 7 | A | 舰队的业务状态面：成员岗位在自治回合内以结构化工具上报状态（按岗位声明的 KPI 槽位对齐），系统保留 append-o |
| agent-fleet-runs | 9 | A | 一次点火到收束的「执行实例」(run)是舰队可观测的一等对象:同源回合串成一串、链位成边、回合明细可回放、变化按舰队实时 |
| agent-fleet-templates | 10 | A- | 舰队的获取与传承面：模板清单（岗位骨架+槽位+节奏默认+prompt 模板+依赖清单）以 pack 形态经既有市场分发， |
| agent-runner | 26 | A |  |
| fleet-blueprint-studio | 17 | A- | 垂直蓝图（vertical blueprint）从内部手艺变客户面产品的契约面：蓝图是与活集群独立的资产对象， |
| fleet-config-overview | 5 | A | Provides a horizontal read-only aggregate bar above the flee |
| fleet-machine-console | 10 | A |  |
| fleet-memory | 15 | B+ | 舰队级工作记忆服务：为萬星 runner 上的部署 agent（及后续壹座 cell 与本地节点）提供跨会话的任务状态、 |
| fleet-owner-iteration | 4 | A- | 集群迭代回路：把「改配置/改蓝图 → 拍板 → 铸成模板新版 vN+1 → 市场发新版 → 订阅者跟新提示」接成主人可用 |
| fleet-owner-surface | 6 | B+ | 集群主人经营坞：把既有的 fleet/cockpit/拍板/KPI/模板机制接成一层主人视角的经营面——总览坞看状态与告 |
| fleet-room-bridge | 3 | A |  |
| fleet-turn-memory | 3 | A- |  |

## 簇 C — chat·会话·记忆（33）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| agent-memory-foundation | 5 | B |  |
| chat-activity-collapse | 5 | A | Presents an assistant turn's thinking, tool, skill, and comm |
| chat-attachments | 3 | A |  |
| chat-chart-rendering | 6 | A | Renders fenced `echarts` blocks in assistant output as live  |
| chat-commands | 4 | A |  |
| chat-composer-controls | 10 | A- |  |
| chat-connect-guidance | 2 | A | 对话内连接引导：模型车道或 MCP 工具因凭据失败时，服务端把失败分类为「去哪里连」的结构化指针旁挂在 WS 事件上，聊 |
| chat-history | 11 | A |  |
| chat-input-focus | 1 | C |  |
| chat-memory | 6 | A | 壹座主聊天面（web UI 回合）的记忆注入与 note 写纪律：把 fd-memory 的 digest 读面以三档阶 |
| chat-outline-navigation | 4 | A |  |
| chat-plan-progress | 6 | A |  |
| chat-streaming | 13 | A- |  |
| chat-ui-shell | 11 | A- | Defines the frontend shell that hosts the chat surface: what |
| chat-usage-display | 3 | A | 对话面的 token 用量与上下文水位显示：回合完成携带用量（done 载荷）、回合脚注、输入框旁的上下文水位条。数据源 |
| chat-welcome-state | 3 | A- |  |
| memory-digest-embed-lane | 5 | A- | digest 向量档位的预算与降级纪律：单次 embed 的等待预算按近期真实延迟自适应、慢样本必须被如实记录、调用方超 |
| memory-distiller | 9 | B | L2 蒸馏：把零 LLM 的 L0 观测 / L1 交接在后台限额地蒸馏为可跨会话复用的事实（fact）与经验（expe |
| memory-eval | 7 | B | 记忆面评测：接续成功率三臂对照（无记忆 / 标题列表 / digest 注入）、digest 渲染契约（预算、召回同源、 |
| memory-federation | 4 | A- | 记忆联邦：舰队记忆服务对壹座 cell 与本地 harness 节点开放——同一格式与协议下三类消费者（萬星部署 d/、 |
| memory-portal-ui | 6 | A- | 人类可读的记忆浏览统一面：壹座 web 新增「记忆」面板供用户浏览自己的 owner 记忆，萬星 console 新增部 |
| memory-surface-hardening | 4 | B | 记忆读写面的输入边界契约与向量规模的观测口径：让非法/极端输入的行为被测试钉死而不是靠推理，让「向量规模是否仍在全表扫描 |
| memory-tier-promotion | 4 | A- | tier 晋升通道的人机分工：AI 可从草稿层提议晋级但永远不能越过 stable，canonical 只由人类手势或受 |
| memory-visibility | 3 | A- | 部署者（owner）对自己记忆的可读与可忘：按 scope / 层（L0-L2）/ 时间的筛选读取面，与带审计、可确认的 |
| session-list-management | 5 | A |  |
| session-ownership | 5 | A | Chat sessions are private to the account that created them:  |
| session-share | 6 | A | Lets a user share one of their chat sessions as a read-only  |
| session-solution-capture | 3 | A |  |
| turn-dispatch | 9 | A |  |
| turn-tracing | 5 | A | Defines the platform's per-turn observability: every dsh run |
| zhiyu-im-bridge | 6 | A- |  |
| zhiyu-room | 11 | A | 萬星·智语（一期·站内）：多人 × 多智能体共席的「空间」。人是可被召回的缺席者，分身默认值守；空间是平台 agents |
| zhiyu-widget | 9 | A | 萬星·智语二期·托管接待嵌入面：商家把房间嵌进自己的网站，站点访客以 guest 席位与商家的分身/服务智能体同房共话（ |

## 簇 D — pack·供给·registry·凭据·计费（43）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| agent-builder-hub | 6 | A- |  |
| agent-builder-workspace | 10 | A- |  |
| agent-materials-plaza | 8 | A- | The Materials Plaza is the outward understanding surface of  |
| auth | 7 | A |  |
| connector-credentials | 8 | A |  |
| credential-file-format | 3 | A |  |
| extension-management-ui | 16 | A- |  |
| extension-marketplace | 8 | A- |  |
| extension-runtime-management | 7 | A |  |
| facet-editor-cli | 6 | B |  |
| facet-market-credentials | 6 | A | 壹座侧的谦面市场设备凭据：每 identity 一台设备身份（Ed25519 密钥），经 facet 既有 |
| facet-platform | 23 | A- |  |
| line-boards | 11 | A | 线看板是壹座对一条外部产品线的原生视图：让用户不离开壹座就能看见该线的状态（有什么、怎么样、要做什么），并让副驾拥有一个 |
| line-credentials | 7 | A- |  |
| logto-auth | 8 | A | Native Logto OIDC login for paas: when `AUTH_MODE=logto`, br |
| market-revenue-share | 5 | A | 市场交易记与分成账：让「上架物被买走」成为有账可查的事实——付费条目的价格形态、不可变成交记、经 sub2api 内账的 |
| model-surface-budget | 3 | B |  |
| pack-agent-scoping | 9 | A | Strengthens focused mode's tool narrowing from composition-t |
| pack-authoring | 17 | A |  |
| pack-bot-units | 4 | A |  |
| pack-category-line-mapping | 2 | A |  |
| pack-display-format | 4 | A |  |
| pack-domain-taxonomy | 4 | A |  |
| pack-installation | 11 | A- |  |
| pack-locale-tracks | 4 | A | pack 显示内容的多语言轨道契约:中文为必填主轨、住在既有字符串字段中,多语言副轨以顶层叠加块部分覆盖;缺省与回落永远 |
| pack-marketplace | 39 | A- |  |
| pack-usage-telemetry | 4 | A | Internal supply feedback for the pack marketplace (roadmap M |
| pack-visibility | 3 | A | Private packs: a creator can publish a pack without exposing |
| paper-trading-credentials | 6 | A | 壹座侧的柏讯模拟交易凭据：每 identity 一枚粘贴式 `fdt_` 长命 token（不过期、可吊销 |
| registry-console-i18n | 6 | A- |  |
| registry-credentials | 5 | A | Stores one MCP-registry credential per user so that installi |
| registry-lineage | 6 | A- | 注册处（谦面组件，`mcp.finddatatech.cloud`）的独立谱系契约：自 fd-1.0.0 起，运行的软件 |
| registry-market-deployment | 3 | A- |  |
| registry-product-home | 4 | A- |  |
| registry-quota-gate | 5 | A- | registry 预检层 wire 当月行数门的行为契约：门的管辖作用域（哪些 server 归 wire 线管）、线内 |
| scoped-relay-credentials | 6 | A | search-relay 的作用域令牌鉴权：平台交给各 cell 的搜索中继凭据不再是全平台单一静态值，而是按 cell |
| skill-content-propagation | 3 | A- |  |
| skill-invocation | 7 | A |  |
| skill-self-evolution | 3 | A |  |
| supply-annotation-overlay | 8 | A | 供给注释层：给 MCP server、MCP tool、skill 三类供给对象一份同构注释（human 五语言轨 +  |
| supply-catalog | 5 | A- |  |
| vendor-identity | 3 | A- | 供应商（vendor）身份类：平台层供应商主体的注册、档案、凭据轨道与收益归属骨架——让第三方以与消费者租户平行的主体身 |
| vendor-server-onboarding | 4 | A | 供方上牌闸：供应商自有 MCP server 经准入审查、工具面声明与 selfcheck 后，由平台 workflow |

## 簇 E — web·多端·门户（28）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| app-center | 5 | A- | 壹座 web 的发现面（`/apps`）：以单一网格呈现运行在平台上的全部生态产品——每个产品一张卡，职责一句话、可用性 |
| desktop-app-update | 3 | A |  |
| desktop-fleet-console | 3 | A |  |
| desktop-fleet-runner | 9 | A- |  |
| desktop-supervisor | 20 | A |  |
| dsh-adapter-boundary | 1 | A |  |
| dsh-contracts | 8 | A | 把平台对 dsh 上游的行为依赖编码为可断言的合同套件：对任意候选 dsh 安装试跑（候选模式），报告每条合同 pass |
| dsh-llm-providers | 4 | A |  |
| dsh-plugin-supply | 6 | A- | The dsh-layer plugin supply surface: operator-whitelisted ds |
| dsh-runtime-bridge | 16 | A |  |
| dsh-version-matrix | 5 | A | 声明并冻结镜像内 dsh 运行时的安装矩阵（意图钉版 + peer 闭包 lock），使构建可复现、启动可验证，把"装错 |
| external-skill-sources | 13 | A |  |
| mp-bind-guide | 1 | A |  |
| mp-command-center | 3 | A |  |
| mp-demo-mode | 9 | A- | Gives unbound WeChat openids a real, bounded chat experience |
| mp-demo-sandbox | 6 | A- |  |
| official-adoption | 7 | A |  |
| official-locale-coverage | 5 | A |  |
| official-pack-showcase | 6 | A |  |
| official-starter-agents-content | 8 | A- | 官方 starter 团队是三桶模型的门面示范：新用户从这里第一次看到「一个 agent 长什么样」。内容必须配得上展示 |
| official-starter-teams | 3 | A |  |
| web-chat-server | 19 | A |  |
| web-chat-ui | 17 | A- |  |
| web-design-system | 8 | A- |  |
| web-list-surfaces | 3 | A |  |
| web-operate-states | 4 | A |  |
| web-search | 13 | A- | Gives the agent real-time web access through two first-party |
| web-shell-resilience | 3 | A | 定义壹座 web SPA 壳的容错契约：壳与哈希资产的缓存姿态、路由渲染崩溃时的页内降级、以及懒加载 chunk 失效时 |

## 簇 F — cell·任务·执行底座（13）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| a2a-agent-serving | 17 | B+ |  |
| cell-gateway | 12 | A- | Defines the hosted deployment's front door: a gateway that a |
| cell-lifecycle | 10 | A- |  |
| cron-module | 12 | C | Defines the in-cell scheduled-task engine: creating, persist |
| harness-adapter | 5 | A | Defines the agent-level harness adapter contract: how the ag |
| project-container | 4 | A |  |
| project-database | 6 | A |  |
| scheduled-task-notifications | 3 | A- | Defines how a user learns that a scheduled task produced out |
| scheduled-tasks-ui | 7 | A- | Defines the web and miniprogram surfaces where users manage  |
| task-engine | 9 | A- | The unified in-cell task engine: one task concept for all un |
| tenant-cell-runtime | 5 | A | Defines the per-user isolation unit ("cell") of the hosted m |
| upstream-concurrency | 3 | B+ |  |
| worker-pool | 7 | A | The cell's task-worker slots: on-demand dsh runtime instance |

## 簇 H1 — 长尾前半（49）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| action-gate | 16 | A | 动作闸把「AI 提议、人确认、系统执行」变成平台原语：让副驾与自主 agent 都能提出动作，但任何重要动作都必须经过明 |
| app-navigation | 7 | A- |  |
| artifact-contract | 2 | A- |  |
| blueprint-trial-bounded-fire | 1 | A- | 试跑的点火步骤必须有时间边界：单个 cron 作业点火悬挂不得占死试跑锁或拖死整场试跑——超时如实入档（fired 行带 |
| bot-relay | 7 | A |  |
| browser-use | 5 | A | The browser-operation lane: a bundled Playwright MCP server  |
| builder-team-templates | 4 | A- |  |
| bundle-manifest | 2 | A |  |
| caller-preferences | 4 | C |  |
| chart-data-binding | 6 | A | Binds a captured time-series chart to the MCP read call that |
| chart-observation-history | 7 | A | Stores the history of a bound chart's data as append-only, p |
| ci-pipeline | 10 | A |  |
| ciyuan-account | 5 | A- | 词元账号：用户与萬星·词元的连接以**零粘贴**绑定——壹座用用户提供的词元登录凭据在词元侧编程铸造一把调用 key，按 |
| ciyuan-embedding-lane | 7 | B |  |
| ciyuan-fork-lineage | 6 | B | 萬星·词元以 sub2api 增量谱系 fork 形态运行（对照 ADR-0017 registry 冻谱系），规定 |
| ciyuan-gateway-identity | 2 | B | 萬星·词元（FindDataRouter）多宿主部署下的登录身份闭环：OIDC 授权启动与回调 |
| ciyuan-gateway-lanes | 15 | B | 萬星·词元（sub2api 增量谱系 fork）在 chat 订阅池之外对外提供三类非 chat 模型能力—— |
| ciyuan-partner-intro | 1 | B | 萬星·词元面向合作伙伴的试用介绍材料：仓内维护、包含测试账号与快速上手， |
| ciyuan-product-surface | 3 | B | 萬星·词元的对外产品呈现面（首页内容、官网页）与产品当前能力保持同步： |
| ciyuan-trial-account | 2 | B |  |
| connection-center | 4 | A | 设置「连接」分节：把散落在「技能与工具 → 商店」tab 与「网络搜索」分节里的用户级凭据连接与搜索接线收拢为唯一管理面 |
| crm-desk-bridge | 4 | A- | CRM 客服台 agent 桥：以钉版本的开源 mcp-chatwoot server 把自托管 Chatwoot 客服 |
| crm-desk-embed | 2 | A- | 壹座内直达客服台：商家/员工在应用中心点击客服台入口，经 Platform API SSO 免密打开 Chatwoot  |
| crm-desk-pack | 3 | A- | 商家 CRM 客服套件 pack：把 CRM 客服台 agent 桥以「连接自带凭据 + pack 订阅安装」形态产品化 |
| custom-presets | 6 | A | User-composed persona presets: any authenticated user assemb |
| dependency-security | 3 | B | 依赖安全轮次的处置契约：仓库各 manifest 上的安全告警要么在归属 manifest 内修复，要么留下带可达性论证 |
| deployment-branding | 5 | A | Deployment-editable branding (company name, assistant name,  |
| device-pairing-auth | 6 | A- | Native app (universal client) login for 壹座: a device pairs o |
| doc-studio | 5 | A- |  |
| document-collections | 2 | A |  |
| document-library-tools | 7 | A- |  |
| document-management | 3 | A- |  |
| document-management-ui | 3 | A |  |
| document-search-index | 3 | A- |  |
| drag-drop-upload | 1 | A- |  |
| dynamic-cluster-composer | 4 | A | Enables users to assemble custom agent clusters at runtime f |
| e2e-testing | 19 | D |  |
| ecosystem-access | 7 | A- |  |
| ecosystem-curation | 4 | A- |  |
| file-persistence | 4 | A |  |
| file-preview | 10 | A- | Lets a user view a file inside the application — one the age |
| first-run-bootstrap | 3 | A |  |
| focus-overlay | 5 | A- | Subscriber-side adjustment of a focused role's effective res |
| foldable-observation-shortcut | 2 | A | Provides a keyboard shortcut to quickly toggle the expansion |
| forward-auth | 9 | A |  |
| installer-distribution | 9 | A- | Distributes Platform desktop installers beyond GitHub: a pla |
| intent-onboarding | 6 | A- | 意图驱动的首配：欢迎页问卷采集业务角色与待办，按平台策展的首配方案（recipe）一键装配——订阅功能集、设默认专家、角 |
| internationalization | 7 | A |  |
| layout-configuration | 5 | A- | 布局是数据：统一页面注册表、版本化布局预设、部署默认→业务角色→用户微调的三层解析链（部署隐藏终局），与配套的部署管理面 |

## 簇 H2 — 长尾后半（49）

| spec | reqs | 评级 | Purpose 首行 |
|---|---|---|---|
| live-runtime-control | 4 | A- | dsh 子进程活控制面：平台桥自定义 RPC（model/set 免重启切模型、session/cancel 真取消、t |
| live-service-testing | 5 | A |  |
| llm-model-management | 12 | A- |  |
| local-agent-registry-feed | 4 | A- |  |
| local-services-launcher | 4 | A- |  |
| marketplace-cluster-view | 2 | A- | Makes cluster packs discoverable in the pack marketplace: an |
| matter-threads | 5 | A- | 事项串：跨方沟通的耐久锚点。v1 落在分身（principal facade）的 escalation 出口——接待 |
| mcp-auth-lanes | 4 | B |  |
| mcp-integration | 10 | A- |  |
| member-knowledge-profile | 6 | A- |  |
| miniprogram-auth | 9 | A- | WeChat login for mini-program clients, built on ACCOUNT BIND |
| miniprogram-client | 14 | A- | Defines the WeChat mini-program thin client: how it carries  |
| mission-control-bridge | 5 | A- | The cell-side Mission Control integration: an opt-in bridge  |
| mobile-app | 11 | A- |  |
| model-selection | 11 | A- |  |
| native-lexicon | 8 | A- |  |
| offline-pack-supply | 5 | A- |  |
| onboarding-guidance | 5 | A- | In-product guidance for non-technical users: a three-step fi |
| ops-console | 9 | A |  |
| permission-mode-selection | 5 | A- | Lets the user see and switch, per chat session, which permis |
| persona-self-evolution | 5 | A- |  |
| platform-billing | 7 | A- | The billing domain of the public agent platform (ADR-0011):  |
| platform-memory-observability | 4 | B |  |
| preferences-ui | 4 | A- | Defines the desktop app's Preferences window: how it is open |
| principal-facade | 8 | A- | 委托人门面：任意委托人（个人或组织）把知识库、工作方式与能力（packs/舰队）聚合为一个 |
| project-identity | 3 | A- |  |
| project-workspace | 1 | A- | Name-based project creation: a user names a project, the ser |
| release-pipeline | 11 | A- | Builds and publishes Platform desktop installers from CI: a  |
| resource-library | 11 | A- | A durable, typed library of artifacts produced in chat — cha |
| resource-library-ui | 12 | A- | The client surfaces where users discover, inspect, and manag |
| role-system | 6 | A- | 按业务分工划分的用户类型（业务角色）：枚举、部署级存储、admin 分配、主角色制、正交管理员标志与准入组映射。本能力是 |
| scheduling-cluster-aware | 3 | A- | Lets a scheduled task target a dynamic cluster instead of a  |
| settings-surface | 7 | A- | Defines the in-app Settings modal: a single overlay surface  |
| sidebar-nav-families | 4 | A- |  |
| sidebar-workspaces | 5 | A- | Gives the sidebar a Workspaces section where past sessions g |
| social-bot-channels | 26 | A- |  |
| studio-ai-drafting | 3 | A- | AI 起草是画布的加速器而非自动化：模型产物永远落为**可编辑草稿**，人的「采用」是唯一写入三桶的门，发射口永远不直接 |
| system-status-dashboard | 5 | A- |  |
| test-process-hygiene | 4 | A- | Test-process hygiene for the `node --test` unit lane (`scrip |
| theming | 6 | A- | Defines the application's light/dark/system theming: how a t |
| tool-description-enrichment | 5 | A- |  |
| tool-discovery | 6 | A- | Gives the agent a reliable way to discover and correct names |
| tool-use-rendering | 5 | A- |  |
| user-runtime-bindings | 6 | A- |  |
| vertical-packs | 5 | C |  |
| virtual-mcp-servers | 2 | B |  |
| voice-lane | 6 | A- | 语音车道：壹座以固定的 OpenAI 音频协议经服务端转发到词元语音车道（转写 + 合成），不感知也不配置上游渠道（豆包 |
| wanxing-facade | 8 | A- | The external serving front door of the agent platform (ADR-0 |
| workspace-selection | 6 | A- |  |
