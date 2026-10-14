# registry-lineage Specification

## Purpose

注册处（谦面组件，`mcp.finddatatech.cloud`）的独立谱系契约：自 fd-1.0.0 起，运行的软件是本方独立迭代的 fork 谱系，与上游 mcp-gateway-registry 的关系收敛为「仅安全修复移植」，本方差异化能力（per-user 长命 key、转发前额度预检）随谱系携带并在生产可达。

## Requirements

### Requirement: 独立版本身份

registry 全栈以自有版本线（`fd-x.y.z`）标识与发布，不与上游版本号比较、不暗示落后；栈内所有容器镜像一律钉版，不允许浮动 tag。

#### Scenario: 控制台版本横幅显示 fd 版本

- **WHEN** 运营者打开注册处控制台
- **THEN** 版本横幅显示 `fd-` 前缀的自有版本号，且可辨认其收敛基线为上游 1.32.0（经 ADR 与维护文档，而非版本号本身）

#### Scenario: 镜像无浮动 tag

- **WHEN** 检视部署栈的 compose 文件
- **THEN** registry、auth-server、mcpgw 三类自建/转发容器全部钉在明确版本 tag 上，不存在 `latest` 等浮动引用

### Requirement: 上游安全单行道

上游的新功能永不并入谱系；上游每次发版后一周内完成其 release notes 安全相关内容的评估，需要移植的安全修复走「摘取 → 全量测试 → 钉版换镜像」流程，并登记台账。

#### Scenario: 上游发版含安全修复

- **WHEN** 上游发布新版本且 notes 含安全修复条目
- **THEN** 一周内完成评估并记录取舍；若采纳，修复以最小摘取进入谱系，全量测试通过后随下一个钉版发布，台账登记来源提交与移植提交

#### Scenario: 上游发版仅含功能

- **WHEN** 上游发布仅含功能与重构的新版本
- **THEN** 谱系不发生任何合并动作，无需发布回应

### Requirement: per-user 长命 key 铸造面在生产可达

控制台用户可在注册处自助铸造不设自动过期的 `wgk-` 前缀长命 API key：明文仅铸造时展示一次，库内只存哈希；可即时吊销，吊销后下一次调用即被拒；存量 key 的 scope 随所属用户组映射变化即时生效；零 key 存在时系统行为与未携带该能力的谱系逐字节一致。

#### Scenario: 铸造与一次性展示

- **WHEN** 控制台用户成功铸造一把长命 key
- **THEN** 响应返回 `wgk-` 前缀明文（仅此一次），此后任何接口、日志与审计均不再出现明文

#### Scenario: 吊销即时生效

- **WHEN** 某把已铸造 key 被其属主吊销
- **THEN** 该 key 的下一次 Bearer 调用得到 401，且不可恢复

#### Scenario: 惰性默认

- **WHEN** 谱系运行且库中不存在任何长命 key
- **THEN** 鉴权与转发行为与未携带该能力时无差异

### Requirement: 转发前额度预检可灰度

mcp-proxy 转发前按调用者映射对其计费账户做零成本额度探测：充足放行；不足在触达上游前拒绝并给出可操作的 402；计费面不可达时按严格/后付模式分别 fail-closed（503）或放行记账；未映射的内部调用者整体跳过；该能力默认关闭，开启与否不改变既有鉴权语义（授权拒绝永不被计费判定掩盖）。

#### Scenario: 额度充足

- **WHEN** 已映射调用者的计费账户余额充足且开关开启
- **THEN** 请求正常转发至上游 MCP server

#### Scenario: 额度不足

- **WHEN** 已映射调用者余额不足或账户被禁
- **THEN** 返回 402 且上游未被调用，拒绝语义对调用者可读

#### Scenario: 计费面不可达

- **WHEN** 计费面超时或 5xx 且处于严格模式
- **THEN** 返回 503 fail-closed；后付模式下放行并落审计

#### Scenario: 未映射调用者与开关关闭

- **WHEN** 调用者不在映射表内，或开关整体关闭
- **THEN** 不发生任何计费交互，转发路径与既有行为一致

### Requirement: 换版可回滚且市场目录不缩水

registry 容器的任何换版必须以可一步回滚的钉版方式进行；换版后必须核验壹座市场消费的全局快照内容（server 与工具可见集）相对换版前无未解释的缩减，以防读面按调用者过滤的语义变化静默缩小目录。

#### Scenario: 换版后快照核验

- **WHEN** registry 容器完成一次版本切换
- **THEN** 以市场 bridge 的同一凭据对换版前后快照做 diff，server/工具集合无未解释缺失，方可宣布换版完成

#### Scenario: 一步回滚

- **WHEN** 换版后出现不可快速修复的回归
- **THEN** 将 compose 钉版换回上一 tag 并单容器重启，恢复换版前行为，无需重新构建

### Requirement: 运行时镜像依赖预算

fd 谱系的 registry 运行时镜像（`mcp-registry`）SHALL 维持精简依赖闭包：本地 embedding 推理不得引入 torch 系依赖；运行时不可达的依赖（无任何 import 路径）不得进入镜像；镜像压缩后体积 MUST 不超过 1.6GB 预算线（基线 2.72GB，目标约 1.45GB），CI 在镜像发布前 SHALL 断言该预算。

语义搜索、注册去重检查、自定义实体索引的对外行为 MUST 不因推理引擎切换而退化：默认 embedding 模型保持 all-MiniLM-L6-v2、输出维度保持 384，既有索引无需强制重建即继续可用；embedding 引擎不可用时，搜索 SHALL 沿既有 latch 机制降级为关键词检索而非报错。

sentence-transformers（torch 后端）路径 MAY 作为可选安装保留，但在默认安装中缺席；当运营者显式选择该 provider 而其依赖未安装时，系统 SHALL 给出明确的加载失败日志并落入上述降级路径，不得崩溃。

#### Scenario: 镜像体积在预算内

- **WHEN** CI 构建出 mcp-registry 镜像并检视其体积
- **THEN** 压缩后体积不超过 1.6GB，且 torch、matplotlib、scikit-learn、scipy、awscli 均不在镜像的依赖闭包中

#### Scenario: 同模型切换引擎后既有索引继续可用

- **WHEN** 以 ONNX 推理镜像替换 torch 推理镜像上线，且不触发索引重建
- **THEN** 语义搜索对同一查询返回与切换前一致量级的结果，embedding 维度仍为 384，已注册条目的向量索引继续命中

#### Scenario: 引擎不可用时降级为关键词搜索

- **WHEN** 本地 embedding 引擎加载失败（如模型文件缺失或 provider 依赖未安装）
- **THEN** 搜索请求以关键词检索返回结果而非 5xx，且日志记录一次明确的加载失败原因，后续请求不再反复触发加载尝试

#### Scenario: 新增依赖须有 import 路径

- **WHEN** 后续变更向 registry 运行时依赖清单新增条目
- **THEN** 该依赖在运行时代码（含管理脚本）中存在实际 import 或调用路径，否则 CI 的体积断言或依赖审计 SHALL 拦截合入
