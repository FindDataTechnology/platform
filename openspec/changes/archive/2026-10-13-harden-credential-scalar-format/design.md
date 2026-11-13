# Design: harden-credential-scalar-format

## Context

事故链（2026-10-12）：平台写出的 `$DSH_HOME/.credentials.yaml` 中，长凭据值被 js-yaml
**默认折行**成一列块标量（`yaml.dump` 默认 `lineWidth: 80`，超长值无法在 80 列内放下时
js-yaml 选择 `>-` 折叠块）。技能用单行 `grep+sed` 取值得空串 → agent 打印文件原文排查 →
完整 PAT 落进会话轨迹。

线上实证（本次复现，runner-c child home）：`LLM_API_KEY` / `LLM_PROVIDER_KEY_FINDDATA`
71 字符→仍单行；`git_pat` 93 字符→被引擎折叠为 `git_pat: >-` + 续行。即：**能不能安全地被
单行取值，取决于 token 长度**——这是最坏的一类不确定性，因为它随着 token 类型/供应商而变。

写入点定位（**两条路径写同一份文件，必须同格式**）：

- `dsh-profile.js` `ensureCredentialsStore()`：profile 树的写出。
- `agent-runner/compose.js` `YAML_DUMP_OPTS`（`:26`，用于 `applyBillingKey` `:283` 与
  `applyDeploymentSecrets` `:328`）：runner child home 的写出——**线上那份 `.credentials.yaml`
  正是它写的**。且 `compose.js:231` 自身也调用 `ensureCredentialsStore`，两条路径在同一份文件上
  交替；若一个加引号一个不加，「值带不带引号」将取决于谁是最后一个写者。**故本 change 把两处
  统一到 `{ lineWidth: -1, forceQuotes: true }`**（task 1.3）。

同文件另有 9 处 `yaml.dump` 属于 patch 文件（settings/mcp/skills/presets/permissions/
tool-search/chart-bind/user-questions），均非凭据载体，不动。

> 实施期协作记录：并行会话的提交 67b813c（同一晚）已对 `compose.js` 加了 `lineWidth: -1`，
> 本 change 与之互补而非重复——它缺 `forceQuotes` 且未覆盖 profile 写入器。本 change 在其上
> 补齐引号统一，并适配了它那条用裸值正则的既有断言（改「取行+剥引号+等值」，保留其单行不变量）。

## Goals / Non-Goals

Goals:
- 凭据文件中的值恒为单行引号标量，长度再长也不折叠。
- 值与旧格式字节等价（YAML 语义不变），加载方零适配。
- 只动凭据文件，其余 patch 文件不动。

Non-Goals:
- 不删除/迁移既有已写出的旧格式文件（重写出时机见下）。
- 不改动权限位（已 chmod 0600）、不改文件名/路径结构。
- 不在平台侧提供新的凭据读取工具（那是交接文档 P2 的另一半建议，范围更大，本次不做）。
- 不改 finddata 侧技能（`cred()` 保留，它读新格式同样正确）。

## Decisions

### D1 · `lineWidth: -1`（不是 0，也不是更大的值）

js-yaml 的语义：`lineWidth: 0` 表示「保持在列宽 0 内」——**等价于永不断行**，实测：
- `lineWidth: 80`（默认）：超长值折叠成 `>-` 块。
- `lineWidth: 0`：**仍然折叠**（这是 js-yaml 的坑，0 不是「不限制」，而是极端限制）。
- `lineWidth: -1`：真正禁用折行，恒一行。

故用 `-1`。这是本 change 唯一有陷阱的选择点。

### D2 · `forceQuotes: true`

值加引号后：①`#`、`@`、`: `、前导空格等字符不会被 YAML 解析器误解；②技能侧按分隔符
切分时，值的边界在视觉上明确。引线带来的唯一代价是文件差异变大（`==` 比较失效），
但凭据文件由平台独占写入、 consumers 都是 YAML 解析器或文本取值，无此需求。

### D3 · 何时生效：不主动迁移，随既有重写时机

现有逻辑是「文件缺失 或 ref 值变化」才重写（`dsh-profile.js:348-350`）。
因此：
- **新部署 / 凭据轮换**：立即得到新格式（这类场合正是事故链所在：轮换后才踩）。
- **存量不动的文件**：保持旧格式，但没有风险升级——凭据值本身没变，且 finddata 侧技能已上
  `cred()` 三形态兼容。

不做「启动时无条件重写」：那会在每次 cold-start 都对所有 child 改动磁盘、触发 dsh 的
凭据 watcher 重载（`dsh-credentials-local` 热重载），为一个 cosmetic 的格式变更引入重启面，
不划算。

## Risks / Trade-offs

- **引号内的单引号**：token 自身含 `'` 时，YAML 会转义为 `''`——解析器仍能还原原串（值与格式
  的语义等价已由 spec 的「解析等价」场景钉死）。实测 PAT/sk-* token 字符集均不含单引号。
- ** diff 噪声**：此次之后凭据文件的行首引号属预期，不作为异常。
- **watcher 触发面**未变：重写条件与既往一致，未新增写盘次数。

## Migration Plan

无数据迁移。首次生效时机为下任一：①该 child 任一凭据 ref 值变化（含 pack 重部署带新 PAT）；
②文件缺失被重建。Need to force early：可直接删除 child home 的 `.credentials.yaml`
（0600，`/data/packs-*` 下）并重启该 agent，或重部署带 secrets 即自然重生。
