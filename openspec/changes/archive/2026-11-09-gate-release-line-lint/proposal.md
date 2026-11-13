## Why

`release/cell-session-persona` 这条线在 2026-11-09 一天之内**四次**被 lint 拦在出片口：每次都是别人推的提交没过 `npm run lint`，出片 CI 的 `Lint (Biome)` 步红，镜像出不来。我这轮人肉清了 15 处（`??=` 落表达式、未用绑定、模板占位符、缺 radix、死导入），清完又长出来——因为**这条线没有任何推送前/推送时的 lint 闸**：

- CI 的 lint 只在镜像仓的快照上跑，**出片时才红**，已推的提交改不了；
- 本地没有 pre-commit/pre-push 钩子（仓里无 husky/lefthook/simple-git-hooks）；
- 多人共用同一条 release 分支，谁推谁负责这件事没人承接。

结果：**每一次出片都要先人工清一遍 lint**，而且清的人往往不是写坏的人。

## What Changes

- 加**本地 pre-push 钩子**（`.githooks/pre-push` + `git config core.hooksPath .githooks`，随仓分发）：推送前对**本次推送涉及的提交所改动的文件**跑 `biome check`，红则拒绝推送并打印修法。
  - 只查改动文件（不是全仓），所以快（<2s）；避免"别人历史欠账挡住我"。
  - 允许 `SKIP_LINT_HOOK=1 git push` 逃生（并打印警告），用于紧急回滚。
- 加**CI 侧的同款闸**（`ci.yml` 已有的 `Lint (Biome)` 不动；新增一条对**推送范围**的检查，PR/push 都能定位到具体文件），让"本地没装钩子"的人也在合并前红。
- 文档：`DEPLOY.md` 的出片段补一句"出片前 `npm run lint` 必须绿；红了先看是不是自己的文件"。

## Capabilities

### New Capabilities

- `release-line-hygiene`：发布分支的推送前卫生闸——改动文件级 lint、可逃生、拒绝时必须给出文件与修法。

## Impact

- `.githooks/pre-push`（新）、`package.json`（`prepare` 脚本设 hooksPath）
- `.github/workflows/ci.yml`（新增推送范围 lint 步）
- `DEPLOY.md`（出片段一句话）
- 不改任何业务代码；不改变 `npm run lint` 的全仓语义（出片仍跑全量）。
