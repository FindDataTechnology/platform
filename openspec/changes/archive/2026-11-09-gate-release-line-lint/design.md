## Context

见 `proposal.md`。约束：

- 这条线是**多人共用**的 `release/cell-session-persona`；本地无任何 git 钩子工具（无 husky/lefthook）。
- 出片 CI 的 `Lint (Biome)` 跑的是**全仓**，且发生在快照仓（提交已离开本机）。
- 2026-11-09 一天四次因 lint 红卡住出片，清障的是我、写坏的不是我——这是**责任错配**，不是技术难题。

## Goals / Non-Goals

**Goals**：让"本次推送引入的 lint 违规"在离开本机前被拦；本地与 CI 判据完全一致；不因别人的历史欠账挡住任何人。

**Non-Goals**：不清理历史欠账（那是 `npm run lint` 全量的职责，出片时仍会跑）；不引入第三方钩子框架；不做格式化（只查，不 `--write`）；不管非代码文件。

## Decisions

### D1 判据是「本次改动的文件」，不是全仓

`git diff --name-only <range>` 过滤代码文件后交给 `biome check <files>`。

- 为什么：全仓判据会把别人的欠账算到推送者头上，第一次被挡就会有人装 `--no-verify`；闸一旦被绕过就等于没有。
- 替代（否）：全仓 + 基线（design-lint 那套棘轮）——适合"本仓自己的欠账"，不适合"多人共用线上别人刚推的红"。

### D2 一个实现，两个入口

`scripts/lint-changed.mjs` 决定判据、过滤与文案；钩子与 CI 只负责取范围、传退出码。

- 为什么：两套判据必然漂移（本项目已经栽过"本地绿 CI 红"多次）。CI 用 `github.event.before..github.sha`，钩子用 `@{push}..HEAD`（退化 `HEAD~1..HEAD`），**范围不同、判定相同**。
- 替代（否）：CI 里再写一遍 biome 调用——省 20 行，换来两份会各自演化的规则。

### D3 逃生阀只放行本地，不放行 CI

`SKIP_LINT_HOOK=1` 跳过钩子并打印警告；CI 那条照跑。

- 为什么：紧急回滚需要能把东西推上去；但"推得上去"不等于"能出片"——CI 仍然红，问题不会被悄悄带进镜像。
- 替代（否）：无逃生阀——回滚时被自己的闸挡住，比漏一个 lint 更糟。

## Risks / Trade-offs

- [钩子要 `prepare` 才装] → `prepare` 在 `npm install` 时跑；没装的人 CI 仍然拦（D2 的同一实现）。两条路覆盖同一件事，不依赖用户记得配。
- [`@{push}` 在新分支/新克隆不存在] → 退化到 `HEAD~1..HEAD`，宁可查得少也不误报；CI 那条用事件里的显式 sha，不受影响。
- [大推送（几百文件）会慢] → 只查本次改动，且 biome 本身很快（256 文件 0.4s）；真慢的是全仓，不是这个。
- [有人 `git commit --no-verify` 或直接 `push --no-verify`] → 挡不住，但 CI 会在出片前红，且指名文件；这是"尽力在最早的点拦住"，不是不可绕过的强制。

## Migration Plan

1. 落 `scripts/lint-changed.mjs` + `.githooks/pre-push` + `package.json` 的 `prepare`。
2. 本机 `git config core.hooksPath .githooks`（`prepare` 已做，执行一次 `npm install` 即可）。
3. CI 加一步，先在一条测试推送上验"故意违规会红且指名文件"。
4. `DEPLOY.md` 补一句。

回滚：删钩子与 CI 步即可，无数据/协议变更。

## Open Questions

- 是否把 `scripts/design-lint.mjs` 的规则也纳入"改动文件"判据？现在它跑在单测里（全仓 + 基线），语义不同（棘轮 vs 逐文件），暂不合并。
