# adopt-curated-external-skills — Design

## 决策 D1：精选源做成 adapter，而不是新的导入管线

货架、安装、转正三条路径都以 `createExternalSourceRegistry` 产出的 adapter 为唯一入口（`list` / `get` / `fetchPackage`）。因此精选源只要满足这个接口，三面就同时通了：

```
lib/curated-sources.js
  CURATED_SOURCES  ─ 人工清单（id / owner / repo / ref=sha / entries[]）
  createCuratedAdapter(pin) ─ list / get / fetchPackage
        │
        ▼
external-sources.js  createExternalSourceRegistry({ extraAdapters })
        │
        ├─ 货架浏览：GET /api/extensions/external/search
        ├─ 用户安装：GET .../install-preview + POST .../install
        └─ 官方转正：lib/adoption.js（preview / adopt）
```

**用注入而不是反向 import**：`lib/curated-sources.js` 需要复用 `external-sources.js` 的 `githubFetchDirFiles` / `parsePackage`；若后者再 import 前者就成环。故工厂加一个可选参数 `extraAdapters`，缺省 `[]` —— 既有调用点行为逐字节不变。

**清单零正文**：条目只写 slug / 上游路径 / 中文用途 / 标签。理由：正文一旦抄进清单，就立刻存在「清单说 A、上游是 B」的漂移，而这正是本 change 要消灭的东西。

## 决策 D2：钉定必须是 commit sha，且 pin 进 originUrl

`originUrl = https://github.com/<owner>/<repo>/tree/<sha>/<path>`。这一条 URL 同时满足三处下游：

| 下游 | 后果 |
|---|---|
| `resolvePinnedRevision` | 命中 40 位 sha 快路径，零请求、`revisionKind=commit` |
| `collectUpstreamLicenseEvidence` | 解析出 `subPath`，先找技能目录的 LICENSE、再回落仓库根 |
| 人工复核 | 点开就是那一刻的内容，分支前进也不变 |

分支名做不到第二、三点：复核时看到的和安装时拿到的可能不是同一份，spec 明令禁止这种静默漂移。

## 决策 D3：不可再分发的条目不进清单，而不是靠运行时门挡

`anthropics/skills` 的许可是**逐技能**的，同一仓库里三种状态并存：

| 上游 | 许可 | 处置 |
|---|---|---|
| 13 条（frontend-design / webapp-testing / mcp-builder / skill-creator / …） | Apache-2.0 | 进清单 |
| pdf / docx / pptx / xlsx | Proprietary（"may not create derivative works / distribute") | **不进清单** |
| doc-coauthoring | 无 LICENSE、frontmatter 无 license | **不进清单** |
| claude-api | Apache-2.0，但 60+ 辅助文件 > `maxAuxFiles(64)` | **不进清单** |

前两类靠运行时门挡也挡得住，但会得到「列表里有一张点安装就失败的卡」——那是更差的交付。第三类是我们自己的包边界问题，同样只能靠不列来解决（不为此放宽 `maxAuxFiles`：那是注入面与内存的边界）。

清单结构由测试守卫（`curated manifest never carries a non-redistributable upstream entry`）：四个专有条目与 doc-coauthoring 出现在清单里即红。

## 决策 D4：许可门新增 `proprietary` 轴

**真缺陷（实测）**：Anthropic 的专有 LICENSE.txt 通篇是 `© … All rights reserved.` + `may not … distribute / create derivative works`，一个已知许可 id 都不命中，于是旧实现走 `not-declared`，`adoptionVerdict` 输出「拒绝：上游未声明许可」——与事实相反（上游声明得很清楚）。规范要求「点名的轴必须是真那个轴」。

实现：`PROPRIETARY` 两组模式（保留所有权利 / 专有；或 "may not … distribute|sublicense|create derivative|reproduce|transfer"）。**只在既无宽松也无已知禁止时生效**——很多宽松许可的样板文字里也带 "All rights reserved"，宽松优先的既有裁决不能被打翻。分层裁决沿用：primary（LICENSE 文件）压制 declared（frontmatter 自述）。

```
evaluateLicense(evidences)
  primary 有信号 → 只看 primary
  ├─ 有 permissive          → admitted（mixed 时留痕）
  ├─ 有 forbidden(copyleft) → rejected: copyleft / non-commercial / …
  ├─ 有 proprietary         → rejected: proprietary      ← 新增
  └─ 都无                   → not-declared: license-absent
```

## 决策 D5：frontmatter 洗成 null 是一等公民

**真缺陷（实测，第二条才撞上）**：`sanitizeFrontmatter` 在「清洗后什么都不剩」时返回 `null` —— 最常见的形态就是上游 frontmatter 只有 `name` + `description`（两个键都由行owns）。`buildAdoptedManifest` 随后 `Object.keys(null)` 直接 TypeError，把整条技能崩掉，而不是产出一个没有 frontmatter 的合法包。`skill-creator` 是第一个撞上的。

修法：`sanitizeFrontmatter(...) ?? {}`，在消费点归一，不改 `sanitizeFrontmatter` 的返回值语义（其它四处调用点依赖 `null` 表示「无残余」）。

## 决策 D6：一条可复跑的审计命令，fail-closed

```
node scripts/adopt-curated-skills.mjs                 # 逐条裁决，只读
node scripts/adopt-curated-skills.mjs --json          # 机器可读台账
node scripts/adopt-curated-skills.mjs --emit <dir> \
     --operator <id> --reviewer <id>                  # 产出转正 manifest + provenance
```

- 任一条被卡 → 退出码 1。理由：pin 漂移成不可再分发的内容时，CI 应当红，而不是安静地少一条。
- `--emit` 强制要 operator + reviewer（规范：转正必须可归属）。
- `GITHUB_TOKEN` 可选：匿名 60 次/小时在 13 条上必撞墙（实测第 6 条起 403）；有 token 时**只对 `api.github.com`** 挂 Authorization，`download_url` 走 raw 主机不带凭据。

## 风险与边界

- **转正产物默认 handless**（`toolFace: "chat"`）。这批技能里 `webapp-testing`、`mcp-builder` 的正文会教用户跑命令，而 Agent 自己没有 shell —— 这是既有规范的既定取舍（宁可「说得好、不假装能做」），不是本 change 引入的。
- **本 change 不写生产数据**：把 13 条推上市场 / 注册处是对外可见的运营动作，脚本已备好，执行前单独确认。
- **上游许可可再变**：pin 保证「那一刻是 Apache-2.0」，不保证「现在也是」。改 pin = 一次审校动作，重跑同一命令即得新的裁决台账。
