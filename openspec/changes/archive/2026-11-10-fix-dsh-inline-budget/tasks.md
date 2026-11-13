# Tasks — fix-dsh-inline-budget

## 1. 调研（已完成）

- [x] 1.1 按事件类型量 overflow 回合体积：平台注入占 13–21%，模型产出+工具结果占 79–87%
- [x] 1.2 在 dsh 内部找到 `dsh-spill-policy` 与 `maxInlineTokens: 12500`（≈40KB，与实测吻合）
- [x] 1.3 确认平台已独占写同一份 `cordis.patch.yml`（`writeLlmProfile`），故平台侧可配、不需改 dsh 源码

## 2. 实现

- [x] 2.1 `inlineTokensBudget(env)`：默认 4000，env `DSH_MAX_INLINE_TOKENS` 可调，非法/≤0 回落默认
- [x] 2.2 `writeLlmProfile` 追加 `spill-policy` 行；旧行替换不重复；scaffold 的 insert 块与 llm 行均保留

## 3. 测试（`test-dsh-inline-budget.mjs`，3 条）

- [x] 3.1 预算解析：默认/override/回滚值/垃圾/0/负数
- [x] 3.2 写入：恰好一行 `spill-policy`、值为 4000、insert 块与 llm 行各仍只有一份
- [x] 3.3 env 覆盖落到 patch
- [x] 3.4 反证：写回 stock 12500 → 2 条红；还原 3/3 绿
- [x] 3.5 邻接：59 个引用 dsh-profile 的文件里，三个 test 套件失败（4/3/2 条）经**基线对照确认为既有红**，与本刀无关

## 4. 规格

- [x] 4.1 `dsh-runtime-bridge`：profile 组合条款补内联预算 + 2 场景

## 5. 上线与观测

- [x] 5.1 上产确认（2026-11-10 舱内实证）— 运行中 cell 的
  `/data/cells/<hex>/dsh/profiles/platform/cordis.patch.yml` 里确有
  `- id: spill-policy / config: { maxInlineTokens: 4000 }`（stock 12500），
  即平台写的 patch 真的被 dsh 读到；镜像 `sha-3db84d7` 及以后均带此行为。
- [x] 5.2 观测（12h，2026-11-10）— overflow 类失败 **28/215（13%）**；按产出分档 16 次
  `reported:true`（干完再撞墙）、5 次 `hasOutput:false`（真白烧，约 2.3%）、6 次无 detail（旧片）。
  工具结果体积：p50 916B / p90 8.2KB / p99 32.3KB / max 50.5KB，>40KB 仅 9 条。
  **结论（否掉自己的假设）**：绝大多数工具结果离旧上限（≈40KB）很远，"降上限减少 overflow"不成立；
  overflow 更可能来自**一轮内多步工具往返的累积**，属会话历史增长问题，另立观察。
- [x] 5.3 归档（`openspec validate --strict` 通过后）
