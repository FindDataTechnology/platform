# 生态素材审校手册（Ecosystem Curation Runbook）

生态技能（Ecosystem Skill）与精选开源 MCP server 进入谦面货架的唯一通道。三轴审校（安全/许可证/质量）逐条过、逐条留痕；任何一轴不过即拒，拒录记台账。对应 change：`add-ecosystem-bridge`（specs: ecosystem-curation）。

## 0. 准入原则

- **只开精选档**：没有社区直灌，没有公开提交面。候选来自运营者主动挑选（开源榜单、社区口碑、自家 agent 场景需要）。
- **上限即目标约束**：首批 ≤15 server / ≤50 技能。数量服从审校吞吐，宁缺毋滥。
- **官方为锚**：官方功能集 = 自家数据 MCP（锚）+ 生态素材（填充）。纯生态拼盘不单独成官方包。
- **一手来源**：只收上游官方仓库/发布物，不收镜像、fork、转载。

## 1. 候选登记

每条候选开一条台账记录（`docs/ecosystem-curation-ledger.md`，追加式）：

```
### <name> — <候选日期>
- 上游: <repo URL>（commit/tag 钉点）
- 许可证: <SPDX id>
- 状态: 考察中 | 入库 | 拒绝（<轴>） | 钉版 | 出局
- 审校: 三轴勾选记录 + 结论一句话
```

## 2. 三轴 checklist

### 2.1 安全轴（一票否决项单独列出）

| # | 项 | 通过标准 |
|---|---|---|
| S1 | 许可证允许我们托管（见 2.2） | 2.2 全过 |
| S2 | 供应链 | 依赖树无已知恶意包（npm/PyPI advisory 扫一遍）；构建可复现或有官方发布物 |
| S3 | 凭据外发 | 代码审查：不向第三方端点发送用户查询内容之外的遥测/上报；有上报项的必须能关，默认关 |
| S4 | 数据外泄 | server 不得把请求内容写入上游自有服务（"query 优化"类功能视为外泄） |
| S5 | 注入面 | 技能正文与 server 工具描述无明显 prompt-injection 模式（诱导调用其他工具/泄露上下文的指令） |
| S6 | 平台凭据 | 容器环境变量清单评审：零平台凭据材料（registry admin token、sub2api key、relay secret） |
| S7 | SSRF 面 | server 自身有出网能力时，评估其 fetch 是否可被诱导打内网（tailnet/元数据地址）；必要则容器层断网 |

### 2.2 许可证轴（一票否决）

| 许可证 | 结论 |
|---|---|
| MIT / Apache-2.0 / BSD-2/3 / ISC | ✅ 放行 |
| AGPL-3.0 | ❌ **托管即拦截**（网络服务需开源改造；不改源码也难自证边界，直接不收） |
| GPL-2/3（仅 server） | ⚠️ 托管不分发不触发传染，但本地 import/改造有风险——默认拒，例外须 ADR |
| 非商用 / CC-NC / 自定义 | ❌ 拦截 |
| source-available（如 anthropics 文档技能族 docx/pdf/pptx/xlsx） | ❌ 拦截（明示非开源，再分发受限） |
| 无 LICENSE 文件 | ❌ 拦截（默认保留所有权利——awesome 类索引里大量无证条目，硬门） |
| Commons Clause / BSL / SSPL 变体 | ❌ 拦截（MCP 生态里"Pro/Plus"社区变体常见，逐个核 LICENSE 原文） |
| 双许可 | 取允许商用与托管的那个分支，台账记录选择了哪条 |

技能正文是**内容**不是代码：CC-BY-4.0 放行（带归因）；CC-NC 拦截。

### 2.3 质量轴

| # | 项 | 通过标准 |
|---|---|---|
| Q1 | 维护活性 | 近 12 个月有 commit/发布；单作者弃坑风险高的不收 |
| Q2 | 传输 | MCP server 优先 streamable-HTTP 或有官方 http 形态；纯 stdio 的评估容器化成本后决定 |
| Q3 | 可用性抽验 | 真 harness（Claude Code 或壹座 cell）装上跑一轮真实任务，工具描述清晰、无幻觉参数 |
| Q4 | 技能正文质量 | SKILL.md 有用法示例与边界说明；正文过 S5 注入面检查 |
| Q5 | 文档 | 有 README/使用文档；工具/资源清单可查 |

## 3. Egress 决议（每 server 必填）

审校时在台账写一行决议，容器编排照此执行：

```
- egress: none | allowlist(<domains>) | open(仅 fetch/浏览类)
- 理由: <一句话>
```

- **none**（默认）：数据/文件/计算类 server 全部断出网。
- **allowlist**：需要上游 API 的（如某数据源），白名单到具体域名。
- **open**：仅限语义就是"替用户上网"的 fetch/浏览/搜索类；必须过 S7。

## 4. 来源标记规范（入库时）

- 技能条目：`source` = 上游仓库 URL（钉 tag/commit）、`license` = SPDX id、`provenance` = `ecosystem`。
- server 条目：registry 描述字段带上游与许可证；容器镜像 tag 钉版本。
- 目录与详情页展示来源+许可证（ecosystem-curation spec: provenance marks）；生态与官方以标记区分，不作质量分级承诺。

## 5. 钉版与再审

- 入库即钉版本（server 钉镜像 tag，技能钉内容快照——pack 语义本就不可变，沿用）。
- 上游出新版：**不自动跟随**。运营者手动发起再审，跑一遍三轴（重点 S2/S5/Q1），通过后升级钉点并记台账。
- 上游出安全通告：一周内评估，按 ADR-0017「安全单行道」纪律处理（评估→摘取或升级→台账）。

## 6. 拒绝与出局

- 任一轴不过 → 拒绝，台账记轴与理由。许可证轴拒绝是永久的（上游换许可可复审）。
- 已入库条目发现违例（如 S3/S4 在抽验后暴露）：立即从目录摘除（unlist 语义），已装快照不动（沿 pack 不可变语义），台账记处置。

## 7. 插件物种的额外一步（2026-11-09）

插件走与技能相同的入口，但**不用 `POST /api/skills`**：它的落点是部署的插件目录（`packs/plugin-catalog.json` 或部署侧 `PLUGIN_CATALOG_FILE`），因为插件只有在镜像/桌面发行期烘入才能被加载。

流程：

1. 按台账第 4 节跑五轴（S1/Q1/Q2/P1/P2），任一硬门不过即拒并记账。
2. 过审后写条目（含五语 `human`、`licence`、`reviewedAt`），提交进目录文件。
3. 出片时把 plugins 一起烘入；发布后该条目在前场的插件页签自动出现。
4. 用户侧：已烘入 → 可启用/已启用；未烘入 → 显示「申请供应」，申请落 `plugin-supply-requests.json`，由下一次出片消化。

**永远不做**：运行期下载、构建、安装插件包；申请动作本身也不做（它只写一行记录）。

### 7.1 贡献类别与越界即拒（2026-11-12）

过审的插件包不止"能加载"，还要说清**它往平台里加的是什么**。每个合成进 profile 的 bundle 在 `dsh-matrix/plugin-supply.json` 里必须写明 `contributes[]`：

- v1 允许：`skill`（提示/流程）、`ui`（面板与视图）、`service`（后台服务）。
- v1 禁止：`tool`、`llm`、`credential`、`channel`。拒绝不是保守，是**接缝不存在**：工具闸只按 MCP server 名索引，插件原生工具没有 server 键也没有清单，声明了也管不住；模型路由、平台凭据、消息通道各有自己的独占契约（萬星词元、S6、会话存档），不是插件可以分走的东西。
- **越界即拒，拒在出片期**：`scripts/check-plugin-supply.mjs` 双向校验（合成而未声明＝未审；声明而合成无处＝死账），`scripts/check-bundle-credentials.mjs` 扫声明里的平台凭据键名；两个门都在 `predist` 与镜像构建里，红即不出片。判据见 `openspec/specs/plugin-supply-gates/`（change `harden-plugin-supply-gates`）。
### 7.3 证据字段（2026-11-12）

"这条过没过、凭什么过、谁签的、审的是哪个上游"以前只在台账里用散文记，机器读不到。现在它是条目的一部分：

```json
{ "id": "pdf-kit", "species": "plugin",
  "evidence": {
    "axes": { "security": {"verdict":"pass","reason":"只读"},
              "licence":  {"verdict":"pass","reason":"MIT-0"},
              "quality":  {"verdict":"pass","reason":"有用例"},
              "P1": {"verdict":"pass","reason":"供给面只读"},
              "P2": {"verdict":"pass","reason":"无运行期下载"} },
    "pin": { "repo": "github.com/acme/x", "tag": "v1.0.0" },
    "licence": "MIT-0", "egress": "allowlist(api.example.com)",
    "reviewedBy": "ops@acme", "reviewedAt": "2026-11-01",
    "reviewValidUntil": "2027-11-01" } }
```

规则（`lib/curation-evidence.js` 一处定义）：

- **轴**：MCP/技能等＝安全 / 许可证 / 质量；插件另加 P1 / P2。任一轴 `needs-human` 即**证据不完整**——停在半路的审不是审。给错 species 的多余轴也拒。
- **钉点**：`repo` + `commit` 或 `tag`。浮动分支不是钉点。
- **出网**：`none` / `open` / `allowlist(host, …)`；拼错即拒（不是"大概通过"）。
- **审校人必填**：无签名的审不算审。`reviewValidUntil` 留空＝永久有效；有日期则过期转 `待复审`。
- **三态**：`已审` / `待复审` / `缺证据`。**证据态与供给态正交**：`未供给` 与 `缺证据` 可以同时成立，读面两维都显示，互不掩盖。
- **采集器不在本仓**：许可证识别、advisory 扫描、出网分类、注入面启发式归属外部 `mcp-gateway-registry` 的评审流水线。人工填写的同形证据**同样合法**，不会因为"没接流水线"被拒。

门在三处，都是**阻断**：`scripts/check-curation-evidence.mjs`（默认判本部署供给的条目，`--all` 判全目录，`--candidate` 判候选文件且只读）接进 `predist`、镜像构建与 CI gates job。今天仓里没有目录文件，三条都是"没东西可判"退出 0——但**第一条条目落地时它就已经在判**，不靠人记得去删某个 flag。台账由 `scripts/gen-curation-ledger.mjs` 生成标记块、CI 比对摘要。

**上屏**：平台面板的插件目录（`/agents?tab=plugins`）在每行**同时**显示两个维度的徽标——供给态（已启用 / 可启用 / 未供应）与证据态（审校完整 / 待复审 / 未审校），完整时另附"复审至 <日期>"。证据是条目自己的属性，所以它跟着条目走，不跟着供给走；没有证据块的条目**不显示**徽标，而不是显示一个编出来的状态。`e2e/plugins-supply.spec.js` 的同名用例钉住这一点（含"未供给且无证据"那一行）。

**广场导出这一跳也带上**：`scripts/plaza-export.mjs` 的 facade / data-anchor 两个 annotator 把证据**逐字段投影**进公开 JSON（只 `state` / `licence` / `reviewValidUntil`，审校人与各轴理由永不出内部），`buildCatalog` 的物料投影也保留它；没有证据的物料**不带这个键**。这一跳最容易被漏：服务面算好了、路由也返回了，投影的白名单一忘，整维就在 API 与市场之间消失（`test-plaza-export.mjs` 有用例钉住，且摘掉投影会立刻红）。

**边界**：这道闸判的是**构建上下文里的那份目录**（默认 `packs/plugin-catalog.json`）。若某个部署用 `PLUGIN_CATALOG_FILE` 指向仓外文件，那份文件不走这三道门——要么把它烘进仓（推荐），要么在提供那份文件的一侧自己跑 `--catalog`。

### 7.2 三封信封同源（2026-11-12）

一份 pack 的**能力**（技能正文、岗位人设、MCP 引用名）是跨 harness 可移植的，编排不是。出货现在只有一个源：

`packs/projections.json`（不可变快照）→ `server/pack-projection.js`（IR + 边界）→ 三个信封：

| 信封 | 内容 | 边界 |
|---|---|---|
| `.yizpack` | 完整清单，装到另一台壹座/桌面 | 平台信封，可带 `fleet` 模板 |
| dsh bundle | `skills/**` + `presets/**` + `package.json`（`dsh.compat` 范围） | **只含能力**：无 patch 层（不接管加载顺序）、无端点、无凭据 |
| 桌面预置清单 | `{bundles:[{file,sha256}]}` | 只有文件名与摘要 |

生成器是**唯一来源**：`node scripts/project-pack-bundles.mjs` 重算全部产出，`--check` 只读比对并由 CI 执行（`ci.yml` 的 gates job）。

- 需要例外时走 `dsh-matrix/route-exceptions.json`：必须写 `name`／`reason`／`approvedBy`／`expiresAt`（epoch ms），**到期自动失效并报复审**，不写到期日等于不放行。

