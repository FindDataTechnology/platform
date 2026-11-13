# doc-studio（文档工坊）技能源

单文件技能：`SKILL.md` 即全部内容（pack 管线一个技能 = 一个 content 字符串，见 design D2 的管线事实）。

## 组装发布（任务 4.1）

- **description**：SKILL.md frontmatter 的 description 行（发布面板的技能描述栏）
- **content**：frontmatter 之后（`# 文档工坊（doc-studio）` 起）的全部正文
- 功能集名「文档工坊」，pack id `fd-doc-studio`，只含这一个技能（v1 无 MCP 引用、无角色，或按需配一个导览 persona）
- 安装走服务端取包（pack-install-server-side-manifest），技能体嵌 python 代码不受边墙影响

## 目录内其余文件

| 文件 | 性质 |
|---|---|
| `postcheck.py` | 技能体内嵌 postcheck 的独立副本（开发侧直跑方便；canonical 在 SKILL.md） |
| `samples-generate.py` | 样张生成器（开发侧；配方段与技能体等价） |
| `samples/` | 真机验证对象（R1–R4 原型 + S1–S3 成稿） |
| `VERIFICATION.md` | 真机验证台账（发布 checklist） |

改任何配方/规则的流程：先改 SKILL.md → 跑"提取验证"（从 SKILL.md fenced 块逐字执行）→ 重新生成样张 → 补 VERIFICATION.md 真机行 → 发布新版本。
