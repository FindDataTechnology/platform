## Context

`/lanes` 白屏根因已在 explore 阶段隔离取证：`lanes.ts` 的
`lanesZh.lanes.shapes.{rerank,websearch,tts}` 与 `lanesEn.lanes.shapes.*` 共 6 条
字符串内嵌未转义花括号；vue-i18n 9 在渲染时经 `@intlify/message-compiler` 编译，
`{` 开插值 → 编译抛 `Unterminated closing brace` → 组件树整体卸载（白屏）。
隔离编译实证：这 6 条错误、其余 13760 条（35 个 locale 文件）全部干净。

现有守测 `frontend/src/i18n/__tests__/localesMessageCompile.spec.ts` 就是把
zh/en 全量消息预编译一遍的测试（能确定性抓到本次 6 条），只是未列入
`FRONTEND_CRITICAL_VITEST`（30 个 spec 里没有它）。

## Goals / Non-Goals

**Goals**
- `/lanes` 在 zh/en 两语言下完整渲染（四行卡片）。
- 该类 i18n 编译缺陷进入关键测试清单（本地 `make` 与 fork CI 都覆盖）。
- 修复随 ciyuan 谱系常规出片滚产。

**Non-Goals**
- 不动车道协议/计费/路由（Go 侧零改动）。
- 不改车道页信息架构（四行卡片结构保持）。
- 不把前端测试接入 build-pool 出片 test job（那是更外层门径决策，本次只把
  缺陷类接进既有 fork CI 会跑的 frontend job；出片层门径另账讨论）。

## Decisions

**D1：转义而非移出 i18n。** 示例形状字符串含 `{query, documents[], top_n}` 等
字面量花括号，vue-i18n 官方写法是 `{'{'}` / `{'}'}` 转义（守测注释亦如此指引）。
备选是把这些形状文本整体移出 i18n 作为语言中立常量挂在行数据上——但那要改
`LanesView.vue` 的数据结构与渲染路径，动面大且丢 en 翻译位；转义只改 6 条
字符串字面量，风险最小。已隔离验证转义后 6/6 编译通过。

**D2：门禁加在 Makefile 清单，不加新 workflow。** `FRONTEND_CRITICAL_VITEST`
已是"关键前端回归"的单一清单，`make test-frontend-critical` 同时被本地与
fork CI（`backend-ci.yml` frontend job 的 `make test-frontend`）调用；入列即
本地/CI 双覆盖。备选是新增独立 CI 步骤——重复机制、维护面更大。

**D3：出片走既有谱系链。** 文案在镜像内（frontend dist 打进 sub2api 镜像），
必须出新片。按 AGENTS.md 先跑 `fd-build-channel` 判路，出 `ciyuan-v0.2.16-8`
（N+1 补丁级；不动上游基线）。GitOps 滚 sub2api deployment。

## Risks / Trade-offs

- [转义后显示形态] → 转义只在源码层；渲染时 vue-i18n 输出的仍是原文
  `{query, ...}`，显示不变（消息编译目标即字面量花括号）。
- [出片链额度] → 私有池额度紧张（历史 2011/2000 用尽）；走 `fd-build-channel`
  当前判路（公开线/有余额池），不硬编码。
- [滚产并发] → 并行会话常见；GitOps 只改 sub2api 一行 mirror+image，推前先
  核 ancestry。

## Migration Plan

1. fork 改 2 文件 → 本地隔离编译验证 + `pnpm exec vitest run` 该守测（轻测本地可跑）。
2. 提交推到 `FindDataTechnology/sub2api` main → 触发 fork CI（frontend job 跑
   `make test-frontend`，含新入列守测）。
3. `ciyuan-tag` bump 到 `ciyuan-v0.2.16-8` + tag → 判路出片 → ccr digest 核验。
4. GitOps 滚 sub2api → 真浏览器验收 `/lanes`。
5. 回滚 = GitOps 回上一 sha（893f610），文案缺陷无害（回到白屏态，无数据风险）。
