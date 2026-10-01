# PAAS Platform Domain Context

## Language

**用户单元（Cell）**:
一位用户在托管部署中的完整运行时隔离单元：一个平台服务进程、其 dsh 运行时与全部可变状态（数据根 + 代理工作目录），对其他用户单元不可见、不可达。一个登录身份恰对应一个 cell。
_Avoid_: 实例、租户进程、sandbox（专指匿名演示单元）

**资料库（Document Library）**:
用户上传文档的归宿：抽取文本、供角色检索，附件原件可从对话条目取回。与资源库互不收编——上传件不进资源库。
_Avoid_: 文档库、知识库

**资源库（Resource Library）**:
对话产物的耐久收藏：图表自动入藏，代理工作目录里的文件经显式保存入藏；入藏即字节拷贝，此后不随工作目录变动。上传件不属于这里。
_Avoid_: 文件库、产物库、资料库（歧义）

**功能集（Pack）**:
运营者发布到市场、订阅者一键装进 cell 的技能+MCP+角色的版本化捆绑包。
_Avoid_: 扩展包、bundle、插件包

**角色（Persona）**:
Pack 中声明的对话入口，在订阅者运行时以本地人设运行——当前选中模型+包人设文本，无独立端点或凭证。
_Avoid_: 智能体、agent（除非指 dsh 内部概念）、机器人、bot

**资源集（Resource Set）**:
一个角色关联的技能与 MCP server 清单。推导视图：从已装包版本快照与覆盖偏好推导，不是被存储的声明。
_Avoid_: 裁剪集、focus set、关联集

**聚焦模式（Focused Mode）**:
运行时组合状态——只装载基线与所选角色资源集的技能与 MCP server。
_Avoid_: 裁剪模式、trim mode、瘦身模式

**基线（Baseline）**:
Deployment 级常量集合：MCP = mcp.json 运维层 ∪ PACK_BASELINE_MCP env；技能 = 仓库 skills/ 目录。
_Avoid_: 默认集、default set、基础集

**覆盖偏好（Overlay）**:
用户对某预设有效资源集的增删偏好：加只能选已启用的资源，减总是合法。是偏好差异而非快照，包升级后对新集合重新解析。
_Avoid_: 自定义资源集、scope 状态、快照

**自建预设（Custom Preset）**:
用户在 cell 本地拼装的对话入口：自选人设文本与本地可用资源，聚焦运行，不经市场发布。
_Avoid_: 用户包、自定义智能体、local pack

**服务契约（Serving Contract）**:
Pack 角色上可选声明的对外服务化条款：出现即表示该角色可按 A2A 协议部署为独立对话服务，含能力声明与鉴权方案。
_Avoid_: 部署协议、serving 块、bundle 协议

**Agent 服务（Agent Service）**:
角色按服务契约部署成的常驻对话服务：有独立端点与服务身份凭证，以 A2A 协议对外。与角色的区别即"有端点、有凭证"。
_Avoid_: 部署 agent、standalone agent、bundle、对外角色

**任务（Task）**:
统一的工作单元：交给某个角色执行的一段指令及其全程（排队、运行、结果、状态）。定时任务是带调度触发的任务，不是另一种东西。
_Avoid_: 使命、差事、指令、job

**执行槽（Execution Slot）**:
任务运行的承载位置抽象。一个 cell 恒有一个主槽承载交互对话；串行与并行是同一任务引擎的两种调度策略，不是两套机制。
_Avoid_: runner、执行器

**工作槽（Worker Slot）**:
只承载任务的执行槽：以单一角色终其一生，空闲即回收，数量有界。与主槽互不侵占——并行时交互对话永不被任务阻塞。
_Avoid_: 分身、工人、子 agent

**委派（Delegate）**:
任何角色都可发起的动作：把任务交给其他角色执行，全部完成后在发起会话收到汇总。"指挥"是架构层说法，不进用户面。
_Avoid_: 调度（专指定时触发）、指挥（用户面）、分发

**侧栏工作区（Sidebar Workspace）**:
会话在侧栏中的分组单位，纯界面组织概念。
_Avoid_: 工作区（裸用）、workspace（歧义）

**代理工作目录（Agent Workspace）**:
角色运行时读写文件的工作目录，属运行时事实，与侧栏工作区无关。
_Avoid_: 工作区（裸用）、workspace（歧义）

**控制台（MC）**:
运营者层的外部指挥面（Mission Control）：cell 主动外连注册为其中的受控单位，任务经它派发与观测。其 "agent" 一律映射为 cell，不映射为角色。
_Avoid_: 指挥中心、调度中心

**dsh**:
外部上游 agent 运行时（npm @deepseek-ai/dsh 家族）：cell 内承载角色对话的子进程本体。以约每日一个 lockstep rc 版本发版、无 stable；平台对其只能选择何时跟随，不能影响其行为。
_Avoid_: agent（指 dsh 内部概念时除外）、运行时本体

**适配层（Adapter Layer）**:
平台中唯一允许了解 dsh 内部的边界：dsh-bridge、dsh-profile、profile 模板 bridge、agent-runner 组合器与 dsh-matrix。上游发版的跟随工作只应发生在这层；其余平台代码经平台自有接口使用 dsh。
_Avoid_: dsh 封装层、runtime 层
