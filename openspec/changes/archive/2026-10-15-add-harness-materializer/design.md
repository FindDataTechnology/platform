# design — add-harness-materializer（切片④ 谦面物化器·serving 面）

## Context

切片③（add-harness-adapter）交付了 harness 分派缝：`harness/registry.js` 按 `AGENT_RUNNER_ACP_COMMANDS`
解析 harness 名 → adapter，部署门按心跳 harness 集放行。但 manager 的 `#spawnChild`（manager.js:851）
对**所有** harness 走同一条 dsh 组合线：fetch skills → `mcpEntry` loader 行 →
`materializeAgentHome`（DSH_HOME seed/patch/LLM profile）→ spawnSpec 带着对 ACP 无意义的
`patchPaths`/`presetId`。ACP adapter 只吃 `{command,args,cwd,env,provider,model}`，`session/new`
写死 `mcpServers: []`（acp.js:223）。net 效果：**ACP 部署裸跑**——persona/skills/MCP/workspace/secrets
全部落空，且白做一份 DSH_HOME。adapter.js 头注明确「manager owns composition」——物化器属于
manager 侧，按 harness 分派，不进 adapter 接口。

谦面 CLI（facet/cli）的本地安装已是五 target 成品（claude-code/cursor/zcode/codex/gemini-cli，
`SKILLS_SUBDIR`/`MCP_TARGETS` 布局表）；本设计与其共享「manifest → 布局」的**概念映射**（skills 是
SKILL.md 近恒等拷贝、persona 落项目级说明文件），但不强行共享代码——两端落点不同（本地
`~/.claude` vs runner 私有工作区 + ACP 线），收敛点是 pack manifest 字段本身。

## Goals / Non-Goals

**Goals**

- ACP-harness 部署拿到完整 pack 内容：persona、skills、MCP、数据工作区，物化进 claude-code
  原生可读的布局；计费归属与 dsh 路径等义。
- dsh 路径**零改动**：`compose.js` 仅新增一个 `export`（uid 守卫 `ensureHomeOwnership` 复用给 ACP 工作区），dsh 组合行为零变化——solo 与 pod 共宿都不碰。
- 诚实降级矩阵：无法如实物化的部分要么结构化拒绝要么留痕 warn，永不静默丢失。

**Non-Goals**

- 不动谦面 CLI / `pack-installation`（cell 侧）——那是已成的另一半。
- 不做 gemini-cli/codex 的 runner 侧布局（v1 只映射 `acp-claude-code`；机制按 harness 名可扩展）。
- 不做 ACP 部署的 `mcpTools` 工具面裁剪（无 ACP 等价物，降级开放；后续若 claude settings
  permissions 映射成熟再立项）。
- 不做 ACP 侧 secrets 受控通道（v1 拒绝；env 对任意二进制不是受控通道）。
- 不动心跳/部署门/harness 白名单（harness 集不变，`AGENT_RUNNER_ACP_COMMANDS` 原样）。

## Decisions

### D1 组合分派按 harness kind，在 manager——不在 adapter 里

`#spawnChild` 以 `this.harnessRegistry.kindOf(harnessName)` 二分：`dsh` → 既有路径原样；
`acp` → 新工作区物化器。理由：adapter.js 边界声明（manager owns composition）是切片③定的
合同，物化器下沉进 adapter 会把组合语义泄漏进「只拥有一个运行时进程」的接口。替代方案
（adapter 自带 compose 能力）被否——能力表会从「运行时能力」漂移成「组合能力」，破坏
perSessionPreset/cohost 那套已经稳定的能力词汇。

### D2 ACP 工作区形状：`<homeRoot>/ws/<agentKey>/`

- `CLAUDE.md` ← persona + serving 后缀（与 dsh preset persona **同一段文字**：
  `persona + "\n\nYou are serving as a standing A2A agent service; answer in text."`）。
- `.claude/skills/<name>/SKILL.md` ← 逐 skill 近恒等拷贝（name=路径末段，同 dsh 侧规则）。
- `data/` ← workspace 声明时创建，env 走既有 `workspaceChildEnv`（AGENT_DATA_DIR/QUOTA）。
- 重物化纪律与 dsh 同构：skills/ 与 CLAUDE.md 覆写，`data/` 永不清除；uid 守卫复用
  `ensureHomeOwnership`（runner 写的树都归同一纪律）。
- cwd = 工作区根（CLAUDE.md/.claude 的发现面；data 声明时 cwd 不再切到 data——claude 的
  项目上下文必须在工作区根，AGENT_DATA_DIR 已把可写面指给工具）。

替代否决：persona 走 `_meta.claudeCode.options.appendSystemPrompt`（SDK 选项）——claude 专属
且盘上不可见，排障/审计面差；CLAUDE.md 对任何读 cwd 的 harness 通用，E2E 可眼见。

### D3 MCP 上 ACP 线：session/new 透传，不做 .mcp.json

spawnSpec 增 `acpMcpServers`（ACP 形状数组 `{name, url, headers}`），adapter 在 `session/new`
透传（resume 不带——协议如此）。registry 名解析在 manager：`registryClient.mcpUrlFor(name)` +
registryToken，与 `mcpEntry` 同源同纪律（同 token、同 fail 语义）。替代否决：cwd 里写
`.mcp.json`（claude 项目级 MCP）——依赖 claude-code-acp 对项目文件的桥接行为，且盘上带
Bearer token 的文件比 wire 通道更宽（进程内传递 vs 落盘）。fake ACP agent 回显收到的
mcpServers 作合同钉。

### D4 凭据诚实矩阵（v1）

| pack 部分 | dsh 通道 | ACP 通道（v1） | 依据 |
|---|---|---|---|
| billing_key_ref | `.credentials.yaml` 覆写 | spawn env 覆写 `ANTHROPIC_API_KEY` | 同一网关基址（acpEnv 的 BASE_URL），换 key=换计费主体；与 dsh 的 deployer 归属等义 |
| secret_refs | `.credentials.yaml` 追加 | **组合期结构化拒绝**（code `HARNESS_SECRETS_UNSUPPORTED`，指名 secret+harness） | env 是 /proc 可见面，对任意 ACP 二进制不是受控通道；今天的行为=写进没人读的 DSH_HOME=静默丢，fail-closed 优于假装 |
| mcpTools | tool-filter patch | warn + 降级开放 | 无 ACP 等价物；能力表哲学（perSessionPreset 同款诚实） |

billing 覆写只在 fetch 成功时生效，失败降 runner 级 key + warn——与 dsh 侧「degrade with a
warning」合同逐字相同。

### D5 布局映射表按 harness 名，v1 单项

新表（与 `AGENT_RUNNER_ACP_COMMANDS` 同键）：`acp-claude-code` → claude 布局（D2）；表外
ACP 名 → 裸工作区（cwd/env/model）+ 一次性 warn 指名未映射的部分。不新增 env 开关——
harness 名就是键，白名单已经在 config.js 把过关。

### D6 测试策略

- 单测（新 `scripts/test-harness-materialize.mjs`）：布局三件落盘、persona 同文、幂等重物化
  （data 存活）、secrets 拒绝、未知 harness 裸降级、billing env 覆写。
- 合同（test-harness-adapter 增例）：fake ACP agent 断言 session/new 收到 mcpServers 数组
  （形状+Authorization 头）；dsh 合同零改动回归。
- 生产 in-pod E2E（切片③探针模式复用）：真 claude-code-acp，persona 影响答复（问「你是谁」
  答 persona）、skill 在 `.claude/skills` 眼见、带 MCP 的 session/new 被接受。

## Risks / Trade-offs

- [claude-code-acp 不读 cwd 的 CLAUDE.md（经 ACP 桥）] → E2E 第一轮就验；fallback =
  `_meta.claudeCode.options.appendSystemPrompt` 补挂（D2 已留缝，改 adapter 一处）。
- [MCP http 形状在 claude-code-acp 的兼容面] → fake agent 合同先钉形状；真 E2E 验接受；
  不通则降级为「MCP 引用 warn + 不传」（诚实矩阵再加一行），不挡部署。
- [env 覆写 ANTHROPIC_API_KEY 的归属正确性] → 词元管理面眼见该 key 的用量记账后再收口
  （同切片③计费门实证法）。
- [ACP 部署曾「能跑」的 secrets 声明现在被拒] → 这是把静默丢改成显式拒；发布注记写明，
  受影响部署应换 dsh harness 或去 secrets 声明。

## Migration Plan

出片走 `fd-build-channel` 判路 → GHA → hkccr → relay → ccr（AGENTS.md 纪律）；滚
runner-serving（唯一受影响负载）。回滚 = 滚回上一 runner tag（gateway/门零变化，无数据迁移；
ACP 工作区目录随下一次部署自然重建）。生产验证 = §D6 第三条 + 双 harness 探针复跑（dsh 侧
必须与切片③同绿——零回归证明）。

## Open Questions

- `_meta.claudeCode.options` 还能承载哪些 SDK 选项（如 permission 策略）——只影响后续
  mcpTools 映射立项，不影响本切片。
