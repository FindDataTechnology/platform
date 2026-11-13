## Why

2026-10-12 spider-heal git_pat 泄露事故（交接文档 `docs/spider-heal-fleet-egress-handoff.md` P2）
的直接触发点，是平台写出的 child 凭据文件格式：

```
$ kubectl -n fd-prod exec deploy/agent-runner-c -- cat /data/packs-KkCie…-spider-heal/.credentials.yaml
version: 1
refs:
  LLM_PROVIDER_KEY_FINDDATA: sk-7e05d6…ef869
  LLM_API_KEY: sk-7e05d6…ef869
  gh_actor: 295187081+FindDataOfficial@users.noreply.github.com
  git_pat: >-
    github_pat_<REDACTED-2026-10-18：已验证失效>…FXMYFHE4h1H7zNX
```

`git_pat` 是**块标量**（`>-`，真值换行缩进在下一行）。技能用单行 `grep+sed` 取值得到空串，
agent 为排查而打印文件原文——完整凭据落进会话轨迹。

岗位点到为止是不够的：finddata 侧已在技能文本里加了 `cred()`（覆盖行内/块标量/空值续行三形态）
并明令「绝不为看清楚打印凭据文件」，但那只修了**这一份技能**。技能正文由各自作者书写，
另一位作者未必知道这个文件的值有可能是多行折叠的——只要平台继续写出多行折叠值，
**下一个手写的单行取值就会再现同样的失败**，而 agent 排查时的本能反应又是「看看原文」。

源头治理：让平台写出的凭据值**在物理上就是单行**（且用引号包起来），单行取值天然成立，
文件里也不存在容易被行界工具误判的多行结构。

## What Changes

child 凭据文件（`$DSH_HOME/.credentials.yaml`）的写出改为**单行引号标量**：

- `dsh-profile.js` 凭据写出：`yaml.dump(doc)` → `yaml.dump(doc, { lineWidth: -1, forceQuotes: true })`，
  彻底禁用折行、所有值加单引号。长 token（GitHub PAT 93 字符、sk-* 71 字符）恒一行一个。
- 其余 patch 文件（settings / mcp / skills / presets / permissions / tool-search / chart-bind /
  user-questions）**不动**：它们不是凭据载体，保持最小改动面；凭据文件是唯一会被 agent children
  直接用于取值的文件。

## Capabilities

### New Capabilities
- `credential-file-format`: child 凭据文件的标量写出格式——值必须单行且被引号包裹，
  使单行文本工具（`grep`/`sed`/`python -c` 单行提取）能可靠取值。

### Modified Capabilities

## Impact

- 代码：`dsh-profile.js` `writeCredentialsStore`（:350）一处，加对应单测。
- 兼容性：YAML 语义等价（引号标量 vs 块标量都解析出同一个字符串），dsh 的凭据加载、
  既有已写出的文件都不受影响——只影响**（重）写出那一刻**之后的格式。旧文件不必迁移
  （下次 ref 变更或首次缺文件时即按其原地重写；这是既有逻辑，`absent || changed` 触发）。
- 安全性：writer 已是 chmod 0600，本 change 只消除取值歧义，不扩展暴露面。
- 联动：finddata 侧技能里的 `cred()` 保留（它仍能正确读新格式，且还能应付其它可能存在的旧文件）。
