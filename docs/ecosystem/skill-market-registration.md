# 技能市场登记指南（公开仓 → skills.sh / SkillHub）

> 面向：运营。这条通道**几乎零代码**——公开仓的形状本身就是市场索引的接口，
> 剩下的工作只有「确认形状 + 登记地址 + 记录实证」。
> 相关文档：[marketplace-landscape.md](marketplace-landscape.md)（§4 技能市场调研）、
> [workbuddy-marketplace.md](workbuddy-marketplace.md)（Git-typed 市场仓）、
> [mcp-registry-publishing.md](mcp-registry-publishing.md)（另一条公开通道）。
> Change：`openspec/changes/add-marketplace-projection-fanout`。

## 1. 机制：市场爬标准形状，不认我们的适配器

skills.sh（Vercel）与 SkillHub 都按**公开 GitHub 仓的标准布局**索引：

| 市场 | 索引命令 | 认的形状 |
|---|---|---|
| skills.sh | `npx skills add <owner>/<repo>` | 仓库内 `SKILL.md`（带 `name`/`description` frontmatter） |
| SkillHub | `npx @skill-hub/cli install <…>` | 同上 + 插件/技能目录约定 |

**所以我们不写逐市场适配器**（design D5）：各市场的索引机制随时会变，而标准形状是最稳的接口。
这也是为什么本变更在 facet 侧**没有为此增加一行代码**。

## 2. 已就绪的公开仓（2026-10-31 实测）

| 仓 | 可见性 | 形状 | SKILL.md 数 | frontmatter 合规 |
|---|---|---|---|---|
| `FindDataTechnology/facet-marketplace` | PUBLIC | `.codebuddy-plugin/marketplace.json` + `plugins/<id>/skills/<n>/SKILL.md` + `agents/` | 162 | 162/162 ✅ |
| `FindDataTechnology/fd-mcp-registry` | PUBLIC | `.claude/skills/<n>/SKILL.md` | 18 | 18/18 ✅ |
| `FindDataTechnology/fd-vertical-packs` | PUBLIC | `skills/<n>/SKILL.md` + `references/` | 41 | 41/41 ✅ |

判据（逐条核过）：每个 `SKILL.md` 头部 frontmatter 带 `name:` 与 `description:`；
`facet-marketplace` 另有 75 个插件目录、103 个 agent 文件。
**主源码仓（同一 GitHub 组织下的私有仓）是 PRIVATE，不能作为被第三方爬取的源**——这是发布前门之一。

复核命令（会重新拉一次远端形状）：

```bash
for r in facet-marketplace fd-mcp-registry fd-vertical-packs; do
  git clone --depth 1 -q "https://github.com/FindDataTechnology/$r.git" "/tmp/audit-$r"
  find "/tmp/audit-$r" -name SKILL.md -not -path "*/.git/*" | while read -r p; do
    head -6 "$p" | grep -q '^name:'        || echo "缺 name: $p"
    head -6 "$p" | grep -q '^description:' || echo "缺 description: $p"
  done
done
```

## 3. 登记地址（运营动作）

登记 = 对外公布「用这条命令能装上」的地址，并在本仓留实证记录：

- **skills.sh**：`npx skills add FindDataTechnology/facet-marketplace`
- **SkillHub**：对应 owner/repo 的安装命令（按其 CLI 当期语法）
- **Claude Code 原生市场**：`/plugin marketplace add https://facet.finddatatech.cloud/api/marketplace/marketplace.json`
- **CodeBuddy/WorkBuddy Git 市场**：`https://github.com/FindDataTechnology/facet-marketplace`

**验收口径（不要放大）**：`npx` 命令能**解析到条目**即达标。
**不锚定"出现在其榜单/搜索结果"**——收录时机由市场自己决定，我们无法承诺（§5 边界三）。

### 实证记录（2026-10-31，本机实测）

```
$ cd /tmp/skillprobe2 && npx --yes skills add FindDataTechnology/facet-marketplace --yes
...
  ✓ ./.agents/skills/brief-draft
    universal: Antigravity, Codex, Cursor, Gemini CLI, GitHub Copilot +17 more
  ✓ ./.agents/skills/case-retrieval-report
...
└  Done!  Review skills before use; they run with full agent permissions.

$ ls .agents/skills | wc -l
152
$ head -6 .agents/skills/brief-draft/SKILL.md
---
name: "brief-draft"
description: "简报占位"
---
```

结论：**命令可解析、151+ 个技能落盘、frontmatter 完整**——达到验收口径。
未声称"已出现在 skills.sh 榜单"（该判据不在此次验证范围，且不在我们控制内）。

公开仓可见性同日复核（GitHub API `private` 字段）：`facet-marketplace` false、
`fd-mcp-registry` false、`fd-vertical-packs` false；`facet-marketplace` 根目录 =
`.codebuddy-plugin/` + `plugins/`（75 个插件目录），manifest 条目含 `name`/`source`/
`description`/`version`。

## 4. 什么时候需要动代码

几乎不需要。只有当**形状**变了才动，且动点在导出侧而不是市场侧：

| 触发 | 动什么 |
|---|---|
| 新市场要求额外清单文件（如 `plugin.json` 变体） | `facet/marketplace-repo.js`（导出器），不是市场适配器 |
| `SKILL.md` frontmatter 要求新增字段 | 同上（`renderSkillMd`） |
| 市场开始支持 URL 型市场（不再要求 Git 仓） | 现行 `marketplace.json` 端点已可复用 |

## 5. 三条诚实边界

1. **收录时间不可控**。两个市场都靠爬取，没有自助提交口；我们只能保证形状正确与地址可达。
2. **公开即不可撤回**。一旦被索引、被 `npx skills add` 装到本地，**那台机器上的副本收不回**；
   我们能做的是删除公开仓内容（后续索引可能保留快照）。
3. **索引范围由市场决定**。它可能只索引 `skills/` 而不看 `plugins/<id>/skills/`——所以
   `fd-vertical-packs` 这种扁平 `skills/<n>/SKILL.md` 形状同时保留，两条形状互为兜底。

## 6. 排错

| 现象 | 根因 | 处置 |
|---|---|---|
| `npx skills add` 说找不到条目 | 仓是 PRIVATE，或 `SKILL.md` 不在它认的目录层级 | 核 §2 表；私仓改名/迁移不可行 → 换公开仓 |
| 装上但描述为空 | `SKILL.md` 缺 `description:` frontmatter | 补内容（内容修整，不动结构） |
| 条目名乱码/带 ID | 目录名不是语义名（`facet-marketplace` 的插件目录是 pack id） | 预期：插件级条目用 pack id，技能级条目用技能名 |
| 更新后市场还是旧的 | 市场侧缓存/爬取周期 | 等一轮；判据仍是「命令能解析」，不是「立刻显示新版」 |
