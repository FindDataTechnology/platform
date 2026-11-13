## Context

见 `proposal.md`「Why」。设计相关的现状：

- 谦面 CLI 的目标面由**两张常量表**单一驱动：`SKILLS_SUBDIR`（技能落盘目录后缀）与 `MCP_TARGETS`
  （各客户端原生 MCP 配置位置与条目形状），`facet/cli/facet.js`。两张表同时被
  `scripts/test-facet-docs-facts.mjs` 读取，断言「文档矩阵 == 出厂 CLI」——文档无法与实现漂移。
- WorkBuddy 的客户端事实（初版取自其官方文档，2026-10-30 **已用真机逐项复核**）：MCP 用户级
  `~/.workbuddy/mcp.json`、项目级 `<项目>/.workbuddy/mcp.json`；`type: "http"` + `url` + `headers`。
  文档的「项目级技能写 `.codebuddy/skills/`」指的是**仓库内代码开发配置**，不是用户级技能列表——
  真机探针定案用户级技能根为 `~/.workbuddy/skills`（详见 D2）。
- 我们已有的 OAuth 连接能力在 `ecosystem-access`（RFC 9728 保护资源文档 + 授权服务器元数据），
  本单先查明「为何从未被桌面客户端验收过」——客户端无 client_id 时硬要动态注册而 Logto 无
  `registration_endpoint`；随后当日翻案打通（静态 `oauth.clientId` 短路 DCR + 身份/网关三处配套，
  端到端实证），详见 D4 与 tasks 1.3/6.3。

## Goals / Non-Goals

**Goals**

- 新增 target 之后，`facet install <pack> --target workbuddy --write-mcp` 一条命令完成技能落盘 +
  MCP 配置写入（贴键），`--oauth` 车道一条命令完成免键写入，用户不手抄 JSON。
- 文档矩阵、CLI 事实、冒烟脚本三者继续单源咬合，新 target 不能靠手工同步。
- 把「OAuth 在真实客户端上是否可用」从推论变成逐环实测记录（结论三跳：**先判卡在授权服务器缺
  `registration_endpoint` → 翻案：静态 client_id 车道服务端端到端实证 → 再定案：5.9.3 客户端仅
  连接器/模板路径消费，用户文件条目为前瞻形状，今日真连接=贴键**，见 D4）。

**Non-Goals**

- 不做插件市场分发（兄弟单）。
- 不新增网关/MCP 契约，不改注册处行为。
- 不实现 WorkBuddy 的快捷指令 / Hooks / 智能体组件的打包（那是插件形态，属兄弟单）。

## Decisions

### D1：扩两张表，不引入 target 适配层

现有实现已经把「目标差异」压缩成数据（目录后缀 + 配置文件位置 + 条目形状），加一个目标的
机械成本是两行常量加一个 `entry()`。引入第三层抽象（target interface）会让单源测试失去意义
（它读的正是这两张表）。

**Alternatives**：为每个 target 建模块目录——被否，五个目标都不需要行为注入，只有数据。

### D2：技能落盘路径先证后落，不照抄

文档只明确了项目级技能目录（`.codebuddy/skills/`）与 MCP 文件（`~/.workbuddy/`），用户级技能
目录未在同页给出。实现顺序定为：**先在真机装一个技能、观察客户端是否识别，再定表值**；
在定案前 `SKILLS_SUBDIR.workbuddy` 不写入代码（宁可先只做 MCP 写入，也不写一个错的目录）。

**Alternatives**：照抄 `.codebuddy`（WorkBuddy 与 CodeBuddy 同族，可能直接读它）——作为候选，
但必须有真机证据才采纳。

### D3：MCP 条目形状按客户端文档逐键落

`{ type: "http", url, headers: { Authorization } }`，写进 `MCP_TARGETS.workbuddy.entry()`。
不写 `command`（这是远程 MCP，不是 stdio），也不复用 `zcode` 的嵌套结构（那是另一个客户端的形状）。

### D4：两条连接车道并存——贴键（headless/CI）与免键 OAuth（桌面日常，同日打通）

本单原把「客户端自己走 OAuth 发现」作为优先连接方式（贴键对非技术用户是漏斗杀手，
且我们的发现文档已在产）。**2026-10-30 对生产端点逐环实测第一跳判为阻塞**：

- 客户端确实内嵌了官方 MCP SDK 的标准 OAuth 流程（授权码 + PKCE-S256 + `registerClient`），
  它的资源侧也正确消费了我们的挑战头（`WWW-Authenticate: Bearer realm="mcp", resource_metadata="…"`）。
- 无 client_id 时 `registerClient` 硬要求授权服务器元数据带 `registration_endpoint`（RFC 7591），
  缺则直接抛 `Incompatible auth server: does not support dynamic client registration`。
- 我们的 Logto 元数据没有 `registration_endpoint`，免注册的兜底开关 `client_id_metadata_document_supported`
  （SEP-991 URL 型 client_id）也没有——当时据此把主路径改为贴键并写下「OAuth 当前不可用」。

**同日第二跳翻案**：「不可用」错在把 DCR 当成了必经环节。成熟方案本就不依赖 DCR——MCP 规范
把 DCR 定为 MAY 且 2026-07-28 版起弃用（转向预注册/CIMD），**静态 client_id 才是优先路径**；
读客户端 asar 实证其 SDK provider 为
`clientInformation(){if(this.options.provider?.clientId)return{client_id:…}}`——provider 一拿到
`oauth.clientId`，`registerClient` 整个环节被短路，进入标准授权码 + PKCE 流程。打通共三处配套
（均生产、已落地）：

1. **Logto Native 应用** facet-mcp-keyless（`tvmzkpz3ld5kqlmse5se9`），回调
   `http://127.0.0.1/oauth/callback`。native 型走 RFC 8252 端口无关回环匹配（注册 URI 去端口
   比对，scheme+host+path 逐字一致即可），客户端每次随机监听端口照样命中——这是免键桌面客户端
   的标准形。无 secret 落任何文件。
2. **网关 origin 注册为 Logto API 资源**（indicator `https://mcp.finddatatech.cloud`，scope
   `gateway:access`）：客户端按 RFC 8707 把 PRM 里的裸 origin 原样作 `resource` 发出，不注册则
   `invalid_target`。租户级 custom-JWT（本实例即支持，无需升级）对网关受众的 token 注入
   `roles` 与 `username`（邮箱），计费与组门和 wgk- 车道同口径。
3. **网关补丁 sha-c216f47**（fork 线 fd-keyless-mcp-audience，基座=自报生产线 506f127d）：
   auth-server 的 Logto provider 经 env `LOGTO_ACCEPTED_AUDIENCES` 追加接受网关**自广告的
   origin** 为 bearer audience——token 的 `aud` 是裸 origin 而非 `/api`，旧集合不认。

端到端实证（无头复刻 SDK 全流程）：授权 → token `aud=https://mcp.finddatatech.cloud` 含
roles/username → initialize 200 → tools/list 160+ 工具。**服务端车道=真打通**——任何按规范消费
预注册 client_id 的 MCP 客户端今天就能免键直连。

**同日第三跳（读出厂 app.asar 逐路径核，5.9.3）**：短路的**前提**是客户端把 `oauth.clientId`
递进 SDK provider，而这在 5.9.3 只成立于**连接器/市场模板路径**（`toConnectorMcpItem`/
`toDependencyItem` 的 auth 映射读 `descriptor.oauth.clientId`——腾讯自家 Outlook 连接器即此形状）；
**用户级 mcp.json 加载器不消费**：`parseMcpServerEntry` 只保留 transport/信任字段（丢弃 `oauth` 块），
`UserMcpProvider → toAuth$2` 只递 `provider:{name}` → 回 DCR 路径 → 即第一跳现场报错的真因。
结论改判为两层：`--oauth [--oauth-client <id>]` 写入 `entryOauth` 形状（`{type:"http", url,
oauth:{name, clientId, scope}}`）是**与客户端连接器模板同形的前瞻条目**——零凭据落盘、客户端哪天
在用户文件接线即激活、无需重配；**今日真连接=贴键车道**（headless/CI 与桌面同一条）。已知非阻塞项：
provider 对 native 应用未回 refresh_token（`offline_access` 被丢弃）→ 车道激活后过期会自动再弹授权
（已登录时近乎无感）。**律：「服务端 + SDK 语义可行」≠「目标客户端消费我们的配置文件形状」——
客户端侧必须按出厂代码逐路径核。**

### D5：文档事实表只扩不复制

`docs/ecosystem/client-matrix.md` 加一列即可，`test-facet-docs-facts.mjs` 不用改断言逻辑——
它按 `Object.keys(SKILLS_SUBDIR)` 自动覆盖新目标。若需要新断言（如"每个 target 的 MCP 条目必须
带 Authorization"），加在同一个测试里而不是新开一份。

## Risks / Trade-offs

- **技能目录猜错 → 装了但客户端不读**（静默失败）→ D2 的真机定案 + 冒烟脚本锁路径 + 指南写明
  "若客户端未识别，见 X 节"。这是本单最大的真风险，因为失败是静默的。
- **WorkBuddy 对远端 MCP 的鉴权行为与我们假设不同**（例如要求 SSE、或 OAuth 与 header 二选一）
  → 走查先做 MCP 连通（`type: http` + header），再做 OAuth 走查；两者独立记结果。
  （结果：两条车道都已在生产端点各自走通；OAuth 车道为无头端到端 + CLI 单测双层证据。）
- **同族客户端路径漂移**：WorkBuddy 与 CodeBuddy 共享约定但可能不同步 → 表里只写已证实的一项，
  未证实的留空并让 CLI 在缺表项时报"该目标暂不支持 X"，不猜。
- **文档矩阵改动触发 docs-facts 测试红**（并行会话在改同一份文档）→ 提交只 add 本变更文件
  （工作区常有其他车道在途）。

## Migration Plan

1. 无数据迁移：纯 CLI 常量 + 文档 + 测试；发版即生效。
2. 回滚：目标从两张表移除即可，不留下服务端状态；已写入用户机器的配置文件由用户自行删除
   （指南给出路径），CLI 不做破坏性清理。
3. 发布节奏：与兄弟单 `add-pack-marketplace-git-channel` 可分开发版，无相互依赖。

## Open Questions

原列两问，本单已各自有结论，留此以免复犯：

- ~~WorkBuddy 用户级技能目录的真实路径~~ → **已定案 `~/.workbuddy/skills`**（真机探针 8/8 识别 +
  缓存 `watch.dirs` 首项 + 客户端代码 `createSkillsService` 三证一致；文档推断的 `.codebuddy/skills`
  是仓库内代码开发配置，属不同面）。
- ~~该客户端 OAuth 授权后是否把 token 写回 `mcp.json`~~ → **已定案：不写回**。车道打通后复核
  （D4），SDK 把 token 存客户端自己的加密凭据库；`mcp.json` 的 oauth 块只有 clientId/scope，
  零秘密落盘。这同时是免键车道对「共享机器/备份泄露」风险的正面答案。
