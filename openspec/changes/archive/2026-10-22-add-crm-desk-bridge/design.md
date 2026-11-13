## Context

寻数 CRM 客服台（自托管 Chatwoot v4.19，cheap 集群，公网 https://desk.finddatatech.cloud，Account 1「寻数 FindData」zh_CN）已由 finddata 侧落栈；本 change 承接其任务 4.1/4.2/4.3 的 paas 侧实施。finddata 侧已验真并钉死选型：`@fazer-ai/mcp-chatwoot@1.1.0`（MIT，实测 123 工具，标准 Chatwoot 可用 100，fork 专属 23 个标准实例 404）。

本设计建立在四组既有机制上（探索阶段已逐一读源核实）：

- **stdio MCP + envRefs BYOK**：`platform.bundle.json` 的 websearch 条目先例——env 名单进 git，值在 MCP patch 写入时从宿主进程 env 解析，是绕过 dsh 子进程凭据名擦洗的合规通道（`dsh-profile.js` toMcpClientEntry）。
- **工具面硬执行**：tool-filter 三层（guard / 注册影 / 组合裁剪）由派生 scope 物化；full-mode 并集现仅从已装 pack 的 allowTools 派生（`lib/full-mode-tool-scope.js`），无操作员层。
- **动作闸**：注册表（id/line/server/tool/risk/impact/preflight）→ propose_action（mcp.json 基线 `actions` server，全 cell 可用）→ ActionCard 主对话确认卡 → 统一执行路径 + 审计。执行器现只讲 Streamable HTTP（目录服务器解析）。
- **envRefs 缺名语义**：警告 + 降级运行（websearch 有意为之），不省略条目。

探索阶段活体钉死的事实（设计依据）：

1. mcp-chatwoot 客户端发的是连字符头 `Api-Access-Token`（`src/client.ts:99`）；实测该头打公网 **200**（下划线头 401、Bearer 200）——需求文档中的「集群内直连 / 配 Bearer」兜底分支不触发。
2. npm 包 `dist/index.js` 即 bun `--target node` 单文件 bundle（带 node shebang、SDK/zod 打包在内）——node 直接跑，零打包工序。
3. server 不读 `ACCOUNT_ID` env；每个工具显式收 `account_id` 参数——技能钉 `account_id=1`。
4. `messages_create` 无草稿态（发出即送达，或 `private:true` 内部备注）——草稿活在壹座对话里。

## Goals / Non-Goals

**Goals:**

- chatwoot MCP server 以「与既有外部 MCP 同款」方式接入壹座 cell（dsh-mcp-client 通道），BYOK 三不纪律构造性成立。
- agent 可见面 = chatwoot 标准子集再裁掉发送类（98 个读/流程工具），fork 专属 23 个与发送类 2 个硬不可见不可调。
- 发送只走动作闸（`crm.message.send`，write 档行内确认），审计留痕、失败如实分类。
- 客服接待技能（仓根 skills/）按「草拟优先、确认后发、失败带原因」执行。
- 失败口径两轮人为故障可验、证据可留。

**Non-Goals:**

- 不做 B 面 pack 化（crm-board-adoption 6.1）与外部应用反代嵌入（6.3）——桥验证通过后另起。
- 不动 Chatwoot 部署、fd-infra-deploy 清单与 mcp-chatwoot 源码。
- 不做 autonomous 定时接待（技能为人工触发、人在环）；Chatwoot 侧 automation/bot 配置不碰。
- 不给 preflight 健康分类加 stdio 探测（故障分类落在工具调用层即可满足 4.3）。

## Decisions

### D1 分发形态：npm 钉版本依赖 + node 直接跑 dist

`package.json` 增 `@fazer-ai/mcp-chatwoot@1.1.0`（lockfile 钉死），cell 以 `node node_modules/@fazer-ai/mcp-chatwoot/dist/index.js` stdio 拉起。dist 本身就是上游官方构建的 node 单文件 bundle，无本地构建步骤、无源码改动。

备选否决：仓内 vendor 预构建产物（手工漂移、评审盲区）；镜像装 bun（多一运行时）；部署为常驻 HTTP pod + streamable-http 条目（新基建 + 运维面，违背「同款接入」；唯一收益是执行器免加 stdio 分支，不值）。

### D2 配置落点：platform.bundle.json 条目（bundled origin），envRefs 只放名字

```json
"chatwoot": {
  "command": "node",
  "args": ["node_modules/@fazer-ai/mcp-chatwoot/dist/index.js"],
  "requiresEnv": ["CHATWOOT_BASE_URL", "CHATWOOT_API_TOKEN"],
  "envRefs": ["CHATWOOT_BASE_URL", "CHATWOOT_API_TOKEN"]
}
```

选 platform.bundle.json 而非 mcp.json：bundled origin 条目在启动时**配置自动同步**（config 漂移随版本走）；mcp.json 条目 seed 一次后会被旧 DB 行永远遮蔽。`requiresEnv`（D4）与 `envRefs` 分立：前者决定条目存废，后者决定子进程 env。

### D3 BASE_URL：公网直连（活体已证），集群内直连为记录在案的备选

`CHATWOOT_BASE_URL=https://desk.finddatatech.cloud`。mcp-chatwoot 原生 `Api-Access-Token` 连字符头实测过公网（Caddy 只丢下划线头），不触发需求文档的两个兜底分支。备选 `http://chatwoot-web.chatwoot:3000`（少两跳、不经边缘）需 cell 侧集群内 DNS 验证且把运行时耦合进 chatwoot namespace——留作故障切换备选（一个 env 翻转即可切），不作默认。token 轮换 = 改部署 env → 重组时 envRefs 重解析，无重装。

### D4 env 全缺时整体省略：新增 `requiresEnv` 语义，不复用 envRefs

未配 env 的部署（platform-demo / agent-runner-serving / fd-memory）上，若条目照写，每个用户每代 cell 都拉起一个必死子进程 + 死条目污染。新增通用键 `requiresEnv`：名单内 env **全部**缺失 → patch 写入时整体省略（静默正常态）；部分缺失 → 沿既有 envRefs 警告+降级语义。不复用 envRefs 做省略，因为 websearch 依赖「缺名警告降级不消失」的现行语义（其 `_comment` 明言）。

### D5 操作员工具面：git 常量名单，全模式上界，经既有 GUARD 硬执行

98-leaf 名单落为版本控制常量（源=验真报告 §4 的标准 100 清单减 `messages_create`/`messages_delete`；fork 专属 23 个因 allow 形式天然不在内）。派生规则：full mode 有效面 = pack 并集 ∩ 操作员面（无 pack 引用但有操作员面者，面即操作员面）；focused = 角色 allowlist ∩ 操作员面；用户 full-surface 覆盖只能恢复到操作员面。名单离线单测对快照。

备选否决：包一层 stdio 过滤代理 server（新活动部件、错误路径双跳）；bundle `permissions.allow`（spec 明文「只存不拦」）；custom preset `mcpTools`（per-user DB 配置、非 git 声明、只对聚焦角色生效）；技能文本纪律（软约束，误调仍可达）。

### D6 发送走真闸：注册 `crm.message.send` + 面上排除 + 执行器 stdio 分支

- 注册表：`{ id: "crm.message.send", line: "crm", server: "chatwoot", tool: "messages_create", risk: write → 行内确认, target: cloud }`，argKeys 钉 `[account_id, conversation_id, content]`（validate-propose-arg-keys 口径），impact 模板呈现会话号 + 内容摘要。`messages_delete` 不注册——「未注册即拒绝」是闸的既有如实失败路径。
- 面的牙齿：`messages_create`/`messages_delete` 不在 98 面内（D5），agent 直接调用被 GUARD 拦下——写工具不进可见面。
- 执行器：action 的 `server` 解析到 bundled/mcp.json 的 stdio 配置时走 StdioClientTransport 分支（每执行一个连接：initialize → callTool → close；env 用与 patch 写入同源的 envRefs 解析，抽共享 helper）。server 名对不上目录也配不出 stdio 条目 → 既有 `tool_unroutable` 如实失败。
- 备选否决：把 chatwoot 部署成 HTTP 服务迁就执行器（D1 已否）；技能层软约束（模型误发无硬拦，违背「发送类=闸管控」）。

### D7 凭据形态：部署级共享 token，注册表显式标注第一方例外

A 租户是寻数第一方账号，平台全体用户共享同一收件箱属预期——执行用部署 env 的共享 token，不走逐用户凭据 ref。这与 action-gate 既有「谦面/萬星以用户自己的凭据执行」条款的关系 = **第一方例外**，在注册表 entry 注释与 spec delta 里显式钉死；B 面（商家多租户）接入时换成逐租户 BYOK（届时 A 租户同样迁入）。preflight 检查 = 宿主 env 存在性（缺失 → 「服务器未配置」拦截，不进确认档位），不做逐用户凭据检查。审计不含凭据明文（args 存内容与 id，digest 落账）。

### D8 技能：仓根 skills/ 目录，草稿活在壹座对话，钉 account_id=1

`skills/crm-desk-reception/SKILL.md`（frontmatter name/description，`/skill:` 展开进提示词；镜像内置、全部署可见——无 chatwoot server 的部署上技能照常加载，工具失败走错误纪律如实上报）。工作流四步：读未处理会话（`conversations_list status=open`，注意 25/页分页）→ 读消息/联系人 → 壹座对话出草稿（默认只草不发）→ 确认后 `propose_action("crm.message.send")` + `messages_list` 读回复核。技能钉 `account_id=1`、网站挂件 inbox id=1；工具名逐一对照验真报告 §4 核实，不引 fork 专属。草稿不落 Chatwoot 私有备注（噪音）；措辞参考 fazer chatwoot-skills 7 个标准技能结构。

### D9 失败分类口径：四类映射，双层落点

| 上游表现 | 分类 |
| --- | --- |
| 401 / token 无效 | 凭据无效 |
| 连接失败 / DNS / 超时 | 网络不可达 |
| 422 / 400 校验拒绝 | 参数被拒 |
| 5xx / 其他上游错误 | 上游错误 |

技能层：任何工具失败原样引用 + 分类，禁空列表冒充、禁静默成功（mcp-chatwoot 错误是纯文本透传 `ChatwootApiError`，技能要求逐字引用）。执行器层：stdio 分支同口径分类（子进程起不来 → 网络不可达/未配置、工具 isError → 原文透传分类）。4.3 验证即对这张表逐行打点。

## Risks / Trade-offs

- [上下文成本：平台部署每个 full-mode 用户每回合 +98 工具 schema] → 用户可在已安装面板自行禁用（availability overlay 既有）；将来收窄只需改 D5 名单一行；B 面 pack allowTools 天然替代粗面。
- [共享 token：全体平台用户可见同一 A 租户收件箱] → 第一方预期；提议/批准/审计逐人留痕；B 面换逐租户凭据（D7）。
- [mcp-chatwoot 2026-03 起停更] → 版本钉死、dist 自包含；风险被 98 面 + 闸收窄；升级版本 = 重新对名单快照 + 四链路验收。
- [名单漂移：server 未来加减工具] → allow 形式使新增工具天然不可见（GUARD 拦）；名单单测对仓内快照，版本升级时强制复核。
- [std io 每执行拉起一个子进程] → 动作是人确认的离散事件，频率低；连接即用即毁无泄漏；量起来再做池化。
- [公网链路依赖 SafeLine/Caddy 边缘] → 活体已证当前链路通；故障切换 = 翻 env 到集群内地址（D3 备选），无需出片。
- [无 server 部署上技能仍可见] → 技能加载与服务器存在性本就正交；失败按错误纪律如实上报即为正确行为。

## Migration Plan

1. 合入 → 出片（fd-build-snapshot 既有链：GHA → hkccr → relay → ccr）→ 滚 platform 部署。
2. platform 部署 GitOps env 增 `CHATWOOT_BASE_URL` / `CHATWOOT_API_TOKEN`（值=finddata docs/TEST-ACCOUNTS.md §七；先 env 后镜像或同窗均可——env 先到只是省略态，镜像先到则部署重启后生效）。
3. 验收四链路 + 两轮失败口径（对生产 desk），证据落 `reports/`。
4. 回 finddata `crm-board-adoption` 勾 4.1/4.2/4.3（注明证据落点）。

回滚：删两个 env → 服务器整体省略（D4），技能/注册表条目留存但动作 preflight 拦截（「服务器未配置」）；或镜像回滚（无 DB 迁移、无数据迁移，全部状态为组合时派生）。
