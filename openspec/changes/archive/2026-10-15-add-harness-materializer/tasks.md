## 1. 物化器（agent-runner/compose-acp.js）

- [x] 1.1 `materializeAcpWorkspace({ homeRoot, agentKey, entry, skillContents })`：
  `<homeRoot>/ws/<agentKey>/` 落 `CLAUDE.md`（persona+与 dsh preset 同文 serving 后缀）、
  `.claude/skills/<name>/SKILL.md`（name=路径末段，同 dsh 规则）、uid 守卫复用
  `ensureHomeOwnership`、workspace 声明 → `data/`+quota；返回
  `{ workspace, dataDir, dataQuotaMb, unmapped: [...] }`。验证：新单测
  `scripts/test-harness-materialize.mjs` 首例（三件落盘 + persona 文本与
  compose.js preset 行逐字对照）绿。
- [x] 1.2 幂等与纪律：重物化覆写 CLAUDE.md/skills、`data/` 存活（写入标记文件后重物化仍在）；
  未知 harness 名（布局表外）返回裸工作区 + `unmapped` 指名 persona/skills/mcp。验证：单测
  两例绿。
- [x] 1.3 MCP 解析：`acpMcpServers(names, registryClient, token)` → ACP 形状数组
  `{name, url, headers:{Authorization}}`（与 `mcpEntry` 同源纪律：同 URL 来源、同 token）。
  验证：单测断言形状与 Authorization 头。

## 2. 接线（adapter + manager）

- [x] 2.1 `harness/acp.js`：`session/new` 透传 `spawnSpec.acpMcpServers ?? []`（resume 不带）；
  spawnSpec 形状注释同步。验证：test-harness-adapter 新例——fake ACP agent 回显收到的
  mcpServers（形状+headers 断言）绿；既有 18 例零回归。
- [x] 2.2 `harness/registry.js`：create() 的 ACP 分支把 `spawnSpec.acpMcpServers` 传进
  adapter spawnSpec；不改 dsh 分支。验证：现有 registry 相关单测绿 + lint 绿。
- [x] 2.3 `manager.js #spawnChild`：按 `harnessRegistry.kindOf(harnessName)` 分派——dsh 路径
  **逐字节不动**（既有分支保持）；acp 路径改调 1.1 物化器，spawnSpec 变
  `{cwd: workspace, env: workspaceChildEnv(spec, scrubbedChildEnv(...)), model, acpMcpServers}`，
  不再 build DSH_HOME/patchPaths/presetId；`unmapped` 非空 → 一条 warn。验证：单测
  （manager 级 fake registry）断言 acp spawn 的 cwd 指向 ws、无 DSH_HOME 目录生成。
- [x] 2.4 凭据矩阵：billing_key_ref → fetch 成功后 spawn env 覆写 `ANTHROPIC_API_KEY`
  （失败 warn 降 runner key，与 dsh 同文）；`secret_refs` 非空 → 组合期抛
  `HARNESS_SECRETS_UNSUPPORTED`（指名 secret+harness，与 fetch 失败可区分）；`mcpTools`
  非空 → warn 降级开放。验证：单测三例（覆写/拒绝/降级）绿。

## 3. 回归与合同

- [x] 3.1 全量单测 `node --test --test-concurrency=1 scripts/test-*.mjs` 全绿（基线 1306，
  允许只增不减）；重点盯 test-agent-serving / test-dsh-pod-adapter / test-harness-adapter
  三家零失败。
- [x] 3.2 `openspec validate add-harness-materializer` 过；lint（adapter-boundary 名单）过——
  compose-acp.js 不得 import `@deepseek-ai/*`。

## 4. 出片与生产验证

- [x] 4.1 `fd-build-channel` 判路 → 按逐步命令出 runner 镜像（GHA→hkccr→relay→ccr 纪律；
  出片前 `git status` 核净）→ 滚 runner-serving。验证：pod 新 sha 眼见 +
  `/api/ready` 绿。
- [x] 4.2 in-pod 真 E2E（切片③探针模式）：部署带 persona+2 skills+1 MCP 引用的
  acp-claude-code 探针包——CLAUDE.md/`.claude/skills` 落盘眼见、A2A 回合答复体现
  persona、session/new 带 MCP 被接受（或按风险预案降级并如实记账）。
- [x] 4.3 计费归属实证：billing_key_ref 部署的回合在词元管理面记到 deployer key 名下；
  secrets 声明部署被拒的错误文本眼见。双 harness 探针复跑 dsh 侧同绿（零回归证明）。
- [x] 4.4 残留清理 + 台账：探针 registry 条目下架/禁用、runner children 复核；
  `docs/registry-maintenance.md` §9 发布记录补行。

## 追记（2026-10-15 生产实证收口）

**4.2 全链眼见**（driver=`scripts/probe-harness-materializer-driver.mjs` 笔记本侧 +
in-pod 断言；部署走 facet 内部通道 `x-facet-token`/`x-facet-user`，slice③ 配方）：

- **persona 通道 live**：acp-member（`harness: acp-claude-code`，persona=「物化验证员」）
  两发 A2A 回合（17s / 16.5s）答复均以「物化验证员报到」开头——CLAUDE.md 经
  claude-code-acp（`settingSources:["user","project","local"]`，源码 10882 行实证）真实加载。
- **工作区布局**：`/data/ws/<agentKey>/` = CLAUDE.md（persona+共享 serving 后缀 216B）+
  `.claude/skills/mat-probe-skill/SKILL.md`（frontmatter 正确）+ `data/`；进程
  `pid=claude-code-acp cwd=ws`、`AGENT_DATA_DIR=…/data` 在 environ。
- **MCP 上线**：冷启日志 `1 MCP`+回合绿 = session/new 携 http 形状行
  （`{type:"http",name,url,headers:[{name,value}]}`，SDK 0.14.1 schema 原文+claude-code-acp
  映射源码双证）被接受。
- **dsh 零回归**：同窗 dsh-member 11s 回合绿；`compose.js` 仅增 export。

**4.3**：secrets 拒绝经真实 A2A 错误道逐字命中
（`-32004 … no controlled secrets channel — deploy this agent on the dsh harness or drop the secrets`）；
计费归票=词元网关日志（`/v1/messages, user_id:88, api_key_id:66, anthropic_messages`——
探针窗口内全部回合记 key 66 名下）；billing 覆写机制由单测+registry 优先级合同钉。

**三个生产发现（如实入册）**：

1. **registry 注册扫描 30s 假阴性（平台既有缺陷，非本变更引入）**：新部署 agent（tailnet
   URL）的 register 卡扫描烧满 30s → nginx 504 → 调用方见 502，但**行已落库且被扫描
   自动禁用**（鸡生蛋机制的慢速化变体）；deploy 侧 billing key 行也因此未持久化。
   driver 以「容忍 502/504→轮询行→toggle 重启用」绕过。建议后续 change：扫描加
   ~5s fetch 超时或部署流不阻塞在扫描。
2. rollover 会为每个 served agent 写 `<homeRoot>/<agentKey>/last-roll.json`（日滚动标记，
   非 DSH_HOME 工件）——「无 dsh home」断言应查 profiles/ 而非目录存在性。
3. billing ref 未持久化的等效性说明：runner 按合同优雅落回 standing key（恰为同一把
   key 66），归票不破；覆写路径（acpCredentialEnv 压过 acpEnv）由
   test-harness-adapter 优先级合同钉死。

**出片链**：`fd-build-channel`→testaction004/build-pool 快照 f9a9547（真 sha de76e2e）→
hkccr→tcr-relay（05:53 OK）→ccr 可拉眼见→fd-infra-deploy `484830b`→ArgoCD sync→
runner-serving 滚出（health 绿）。探针残留：六探针 registry 条目全部 disabled、
runner children 0、无存活 harness 进程；本机临时凭证已清。
