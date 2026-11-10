# 创作与发布能力包（Creating Packs）

从零做一个能力包（pack）并发布到谦面市场。本文是创作者深度指南；壳内 `#/docs` 的
「创作」块是一句话级入口，遇到细节回到这里。

## 0. 前置

- **身份**：发布需要 `creators` 组（Logto 组织）。开通方式：市场侧运营在 Logto 管理台
  （`auth-admin.finddatatech.cloud` → Organizations → `creators`）把用户加入。浏览、订阅、
  安装不需要该组。
- **工作台**：组装与发布都在壹座（或谦面域直连登录，同一身份）完成；草稿存在你自己的
  cell 里，发布前不对任何人可见。

## 1. 能力包是什么

能力包 = **技能（内联内容）+ MCP 引用（只引注册处条目）+ 角色（persona）** 的版本化清单。
装一个包，它的部件一起到位；每装一次取一个确定的版本快照。

内容边界（发布门强制，设计上有意收窄）：

- **技能**内联全文，不引外部文件；
- **MCP 只能引用注册处已注册的 server**（`registryName` 引用，不能写端点/命令——
  一个包永远无法引入运营者没注册过的服务）；
- **角色仅限 persona**（人设文本 + 可选服务契约），不能携带 baseUrl/模型/凭据。

**统一模型锚（agent-document）**：上面三件就是平台唯一组合模型「智能体文档（Agent Document）」的三个桶——角色（persona）+ 技能（skills）+ MCP 工具（mcp），作为一个不可分的创作与展示单元；行为契约见 `openspec/specs/agent-document/spec.md`。同一份文档有四个发射口：①自建预设（cell 本地，不过发布门）②pack 草稿（→ 市场发布门）③团队模板（→ 部署）④蓝图（→ 批准/铸造/迭代）——四个发射口过同一套既有校验器；编辑面可以合一，四条生命周期各自独立。

## 1.5 命名与类型规约（2026-10-27 起）

- **种属词**：分发单元一律「能力包」（en: Pack），市场=「能力市场」。旧称「功能集」停用。
- **包名自由**：发布门**不审核显示名的后缀或词形**——「套件 / 工坊 / 分身」等历史后缀不再承担任何类型语义，起名只管表达。
- **类型唯一通道 = 市场徽章**，由 manifest 结构自动推导，作者无法自报或覆盖：
  带 `fleet`/`cluster` 组织块 → **蓝图**；含 `facade` 块或带服务契约（serving）角色 → **分身**；
  有角色无组织块 → **助手**；纯技能/MCP 捆绑无角色 → **工具**。
- 官方五枚舰队种子已换显示名：公司式舰队→AI 公司、内容工厂舰队→内容流水线、
  情报站舰队→晨报情报站、投研晨会舰队→投研晨会、客服护航舰队→客服班组。

## 2. 三条组装路径

### 2.1 壹座内手工组装（从零开始）

设置 → 能力包 → 我的创作 → 新建能力包：

1. 填名称（≤80 字）、描述（≤2000 字）、标签（≤10 个，每个 ≤24 字）；
2. **技能**：贴 SKILL.md 正文（技能名匹配 `[A-Za-z0-9._-]`、1-64 字符，描述 ≤300 字，
   正文 ≤64KB，每个包 ≤10 个技能）；
3. **MCP 引用**：从选取器勾选注册处 server（≤5 个）；可选收窄工具面（`allowTools`
   工具清单，≤64 个名字——空收窄会被拒；不填 = 该 server 全量工具面）；
4. **角色**：persona 文本（≤16KB，每个包 ≤3 个）；带服务契约的角色可以部署成
   Agent 服务（协议标识 + 可选卡片声明/工作节奏/回合预算——都是声明，不是运行时配置）；
5. **可选**：三步使用指南（`guide`，恰好三步，标题 ≤60 字、正文 ≤500 字，详情页原样渲染）；
6. 保存草稿 → 发布。发新版本 = 编辑同一草稿再发布（见 §4）。

### 2.2 自建预设一键流（有对应 preset 时推荐）

设置 → 自建预设 → 行内「发布并部署」：服务端把预设转成草稿——技能中「你自己的技能 +
部署基线」内联带走，其他包的技能不带；MCP 引用能对上市场目录的按 registryName 存下，
对不上的不带。**转换结果附一份报告**：带走了什么、还需替换什么——照报告补齐后发布。

### 2.3 manifest 直发（作者面）

谦面 `#/mine`（或市场作者面）提供 manifest 直发入口：把完整 manifest JSON 提交给
发布端点，校验错误原样返回。适合脚本化/批量发布；与上面两条路径过同一道发布门。

## 3. manifest 形状（速查）

```json
{
  "name": "包名（必填，≤80 字）",
  "description": "描述（≤2000 字）",
  "notes": "版本说明（可选，≤500 字，随版本不可变）",
  "tags": ["标签"],
  "category": "垂类 slug（可选，[a-z0-9-]{1,32}）",
  "visibility": "public | private（默认 public）",
  "skills": [{ "name": "skill-name", "description": "≤300 字", "content": "SKILL.md 正文" }],
  "mcpServers": [{ "registryName": "fd-open-data-mcp", "allowTools": ["read"], "requiredGroup": "legal" }],
  "agents": [{ "id": "agent-id", "name": "角色名", "persona": "人设文本", "serving": { "protocol": "a2a" } }],
  "guide": { "steps": [{ "title": "准备", "body": "..." }, { "title": "提问", "body": "..." }, { "title": "获得", "body": "..." }] }
}
```

约束速查：技能 ≤10（名 `[A-Za-z0-9._-]`，描述 ≤300 字，正文 ≤64KB）；MCP ≤5；
角色 ≤3（id 不得落在 `user.` 保留命名空间）；标签 ≤10；`notes` ≤500 字。

### 3.1 多语言显示（可选，add-pack-locale-tracks）

**中文是主轨**：上面所有显示字段的字符串就是中文，永远必填；旧包零改动。

要出英文副轨，加一个**顶层 `i18n` 叠加块**——基字段形状不变，只覆盖想翻的显示字段；
缺某语言或某字段一律回落中文，不需要写回落表：

```json
{
  "name": "政心盯梢集群",
  "description": "……",
  "guide": { "steps": [{ "title": "准备", "body": "…" }, { "title": "提问", "body": "…" }, { "title": "获得", "body": "…" }] },
  "i18n": {
    "en": {
      "name": "Policy Sentinel Cluster",
      "description": "…",
      "guide": { "steps": [{ "title": "Prepare", "body": "…" }, { "title": "Ask", "body": "…" }, { "title": "Get", "body": "…" }] },
      "skills": { "intel": { "description": "Collects intelligence" } },
      "agents": { "watch": { "name": "Watch Post" } }
    }
  }
}
```

规则（发布门逐字段点名报错）：

- locale 键为小写 BCP-47（`en`、`en-US`、`ja`…），**不得写 `zh`**（中文在基字段）；
- 只能覆盖已声明的字段/实体：`guide.steps` 按索引且**三步整组翻或整组不翻**；
  `skills` 按技能名、`agents`/`bots` 按 id、`card.skills` 按能力 id；
- 覆盖值遵守与基字段相同的长度帽；`description` 与 `guide` 正文另受 **3:1 长度比率**约束
  （任一侧不足 20 字符不施比率）——防「贴错语种/贴错内容」，正常翻译不受限；
- **en 副轨禁辞同扫**：绝对化替代宣告（如 "replace all human work"）会被发布门拒绝
  （与营销物料审计同一规则）；中文基轨本版本不扫。
- 集群模板的显示字段走 `fleet.i18n`（`{ "en": { "name": …, "members": { "<ref>": { "title": …,
  "kpiSlots": { "<slotKey>": { "label": … } } } } } }`）；岗位 `promptTemplate`/persona 属内容层，不可本地化。

**消费方接法**：市场与安装读面接受 `?locale=<tag>`（无参时看 `Accept-Language`，再缺省中文）。
未覆盖的语言永远得到中文——旧客户端不传 locale 的响应与今天逐字节一致；谦面市场页等外部
消费方零改动可用，需要副轨时自己带上 `?locale=`。搜索本版本仍是中文检索（英文文本不建索引）。

## 4. 发布纪律

- **版本不可变**：每次发布追加 vN+1，内容冻结；要改内容就发新版本。
- **版本说明**：每版可带一段 `notes`（≤500 字）——用户看版本历史时靠它理解变化，
  建议写「这版改了什么、为什么」。
- **订阅 vs 安装**：订阅是账目面（记录在市场，与壹座共享）；安装是物化面（取一个确定的
  版本快照落进运行时）。已装快照不因新版本自动变——用户手动升级。
- **下架与可见性**：下架 = unlisted（浏览隐藏，已装快照不受影响）；`visibility: private`
  的包只有你自己可见（连版本列表都按详情可见性放行）。

## 5. 发布后

- 在 `#/mcp` 能看到你的包引用的 server 的工具面与来源标注；在 `#/packs` 详情页能看到
  版本历史与每版说明。
- 部署成 7×24 agent（带服务契约的角色）→ 萬星；订阅者经 CLI 或壹座装进自己的编辑器。

### 官方转正（operator only）

**这是运营侧动作，不是创作者路径。** 目的：把外部市场里真正好的热门技能，经审校后变成
**平台的官方 Agent** 上架。它不改变 `#/packs` 的任何准入规则——转正是「先审后上」，不是绕过审校。

#### 三条硬约束

| 约束 | 说明 |
|---|---|
| **许可** | 只接受 MIT / Apache-2.0 / BSD / ISC。AGPL / GPL / 非商用 / 无声明**硬拒**。判定**读上游 LICENSE 原文**，不读外部货架的 `licenseState`（那字段两源都恒为 `unknown`）。 |
| **快照** | 转正那一刻把技能正文 + 辅助文件整棵内联进包版本，并钉定上游 commit。运行期不回源——上游删了，官方资产仍然完整。 |
| **可归因** | 每次转正记 `adoptedBy` / `reviewedBy` / `reviewedAt`，随版本冻结。发布账号必须在部署的官方 roster（`OFFICIAL_AUTHOR_EMAILS`）内，否则「官方」标记不亮。 |

#### 许可分层（凭证 > 自述）

```
LICENSE / COPYING 文件        → primary（授权凭证）
frontmatter / package.json    → declared（作者自述）

有 primary  → 只认 primary；自述仅入审计记录（记 declared-license ignored）
无 primary  → 才退到 declared，并记 declared-only 提醒复核
```

为什么分层：一个 AGPL 仓库的技能若在 `SKILL.md` 里写 `license: MIT`，同级合并会把它洗白放行。
**凭证优先于自述**，这是代码里的裁决顺序。

#### 工具面：CLI 技能必须显式放宽

转正产物默认 `serving.toolFace: "chat"`（无 shell / 文件 / 浏览器 / 子代理）。
但**大量热门技能靠 CLI 干活**——正文写 `nano-pdf edit deck.pdf 1 "..."`、
frontmatter 声明 `requires.bins: ["nano-pdf"]`。此时 chat 面会让产物「叫用户跑命令、自己没 shell」。

管线会探测 `requires.bins`：
- 探测到 + 未显式放宽 → **拒绝**（`toolface-insufficient`），绝不静默产出残废包；
- 审校者显式放宽（`widenFullToolFace`）→ 产物不声明 `toolFace`（= 全工具面），并记入审校提示。

#### 三轴互不相交（展示面）

```
类型徽章 badge      ← 结构推导（蓝图/分身/助手/工具）
官方性  official    ← 部署 roster，作者不可自报
来源    provenance  ← manifest 的 adopted 记录
```

「官方精选 · 已审校」在界面上出现**当且仅当** `official === true ∧ adopted === true`。
只带 adopted 记录的包仍读作社区条目——manifest 里写再多也不能给自己发官方身份。

#### manifest 形状

```json
"provenance": {
  "kind": "official-adopted",
  "upstreamUrl": "https://github.com/acme/repo/tree/main/skills/x",
  "upstreamName": "x",
  "license": "MIT",
  "revision": "4a93985763241755401a10678395303de4e720ba",
  "adoptedBy": "ops@finddata.cloud",
  "reviewedBy": "reviewer@finddata.cloud",
  "reviewedAt": "2026-10-31T02:00:00.000Z"
}
```

#### 已知边界（运维）

- **只有 Smithery 源可转正**：其 `originUrl` 是 `github.com/.../tree/<ref>/<path>`，可钉定。
  SkillHub 的 originUrl 是市场页，钉不住 → 直接拒绝（宁可不上架，也不钉不住就上）。
- **GitHub 匿名 API 60 次/小时**：一次转正约 5–8 个请求，批量转正必须配 token，
  否则第 8 枚左右开始 403。

### 回流官方市场（自部署者）

包发布在**你自己的实例**上时，用 CLI 把它一键搬到官方市场——跨实例传输体就是 CLI：

```bash
npx @finddatatechnology/facet publish <功集id> --from https://<你的实例地址>
```

- **登录**：首次运行会打开官方市场的绑定码页（登录**创作者账号**），把 6 位码输回终端
  完成设备配对；之后每次静默续登，token 不落盘。
- **门全在官方侧**：creators 组、清单校验、工具声明门、限流——与网页发布完全同一套。
- **版本续推**：首发记下 源id→官方id 映射，同源再发自动出新版本（`--new` 强制新包，
  `--pack-id` 手工指定）；本地 manifest 文件也可以直接 `facet publish <file>`。

## 6. 排错

| 症状 | 原因与处置 |
|---|---|
| 发布 403 | 不在 `creators` 组——找运营加入 Logto 组织 |
| 校验报 MCP forbidden key | 写了 `url`/`command` 等字段——MCP 只能 `registryName` 引用 |
| 校验报 allowTools | 空数组或名字格式不对（`[A-Za-z0-9._-]`，1-128 字符） |
| 一键流报告「pending」 | 预设里的技能属于别的包 / server 对不上目录——按报告替换后重发 |
| 详情页看不到新版本 | 发布的是草稿未点发布，或包是 private 且你在用别的身份看 |


## Agent Document：三桶模型与四个发射口

壹座把「一个 agent」看作一份 **Agent Document**：角色预设（persona）+ 技能（skills）+ MCP 工具面（mcpServers）三桶，一份文档四处发射——① 会话预设（在 /studio 画布编辑后直接发射）② pack 草稿（走 pack-authoring 的校验/发布链）③ 舰队模板（装台器按模板装舰队）④ 蓝图（蓝图构造间，试跑签字封签后可售）。能力 spec 见 `openspec/specs/agent-document/spec.md`。
