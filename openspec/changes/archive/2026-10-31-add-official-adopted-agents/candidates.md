# 官方转正候选清单（4.1）

> 采集于 2026-10-31，真上游（不打桩）。证据分级标注：
> **✅已验证** = 实跑过 `lib/adoption.js` 管线并拿到结论；
> **⏳待验证** = 只有货架元数据（热度/来源 URL），许可与钉定需 GitHub API（当期匿名限额耗尽，60/h）。

## 一、已验证（实跑管线）

### 1. `smithery/nano-pdf` — 唯一可转正候选 ✅

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf` |
| 仓库热度 | **178,203 stars** |
| 许可证 | **MIT**（`repo:LICENSE` = primary 凭证，最硬） |
| 钉定 | ✅ `4d2a9f8bb4c47da0daae7fd820cab33fa450ef7b`（commit） |
| 技能体积 | 432 字符，无辅助文件 |
| 能力需求 | ⚠️ **`requires.bins: ["nano-pdf"]`** —— 依赖 CLI |
| 裁决 | `需审校者放宽工具面`（默认 chat 面装不下） |

**结论**：许可与钉定都过硬，唯一门槛是工具面。转正需审校者显式 `widenFullToolFace`，
产物为全工具面（能真跑 `nano-pdf` 命令）。**这是最贴近「真热门 + 真宽松许可」的一枚。**

### 2. `smithery/phodal#pdf` — 拒绝（许可）✅

| 项 | 值 |
|---|---|
| 上游 | `https://github.com/phodal/auto-dev/tree/master/examples/skills/pdf` |
| 许可证 | **GPL**（`repo:LICENSE` primary） |
| 裁决 | `拒绝：许可 copyleft 不可再分发` |

留着作为**否定样本**：证明许可门在真实上游会硬拒，不是摆设。

### 3. `skillhub/pdf-skill`、`skillhub/mainpdf` — 拒绝（不可钉定）✅

| 项 | 值 |
|---|---|
| 上游 | 市场页 `https://skillhub.cn/skills/<slug>`（非 git 树） |
| 许可证 | 仅 `frontmatter: MIT` → `declared-only`（无凭证） |
| 裁决 | `拒绝：上游不可钉定` |

**结构性结论**：**SkillHub 源当前全部不可转正**。其 originUrl 是市场页，
反查不到可钉定的仓库树。要转正必须先补「市场页 → 上游仓库」的解析路径（后续班）。

## 二、候选池（待验证，热度排序）

只拿到货架元数据，许可与钉定未验（GitHub 限额）。按热度：

### Smithery（可钉定，优先）

| 条目 | 仓库 | stars |
|---|---|---|
| `nano-pdf` | openclaw/openclaw | 178,203 ✅已验 |
| `pdf`（learn-claude-code） | shareAI-lab/learn-claude-code | 16,766 ⏳ |
| `pdf`（Personal_AI_Infrastructure） | danielmiessler/Personal_AI_Infrastructure | 6,313 ⏳ |
| `pdf`（auto-dev） | phodal/auto-dev | 4,351 ❌ GPL |
| `pdf-generator` | jeremylongshore/claude-code-plugins-plus-skills | 1,221 ⏳ |

### SkillHub（热度最高但不可钉定）

| 条目 | downloads | stars |
|---|---|---|
| `pdf-image-text-extractor` | **319,147** | 190 |
| `pdf-master` | 10,178 | 2 |
| `martin-pdf` | 4,735 | 0 |

> 这三枚热度远超 Smithery 全部候选——**这正是「SkillHub 不可钉定」这条限制最痛的地方**：
> 最热门的货恰好全在不可转正的那一侧。补「市场页→上游仓库」反查是高价值后续项。

## 三、下一班待办

1. **等 GitHub 限额重置**后补验候选池（`shareAI-lab` / `danielmiessler` 两枚最有希望：大仓通常有 LICENSE）。
2. 确定首发 1–2 枚后走 4.2（真实 mint 上架，需出片）。
3. 若决定给 SkillHub 开口子，先补 originUrl 反查（会显著扩大可转正池）。

## 四、选型判据（本清单体现的取舍）

- **许可硬门槛先行**：GPL 直接出局，不看热度。
- **必须可钉定**：钉不住就不上架（宁可拒绝，不做「会变」的官方资产）。
- **热度是发现信号，不是准入**：`pdf-image-text-extractor` 31 万下载也照样因不可钉定出局。
- **能力需求必须明示**：CLI 依赖的技能转正时要留下「需放宽工具面」的明确记录，不能静默降级。
