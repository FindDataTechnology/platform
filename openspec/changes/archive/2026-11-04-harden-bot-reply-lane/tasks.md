## 1. 数据模型与迁移

- [x] 1.1 `bots` 表新增 `persona TEXT NULL` 与 `allow_tools INTEGER NOT NULL DEFAULT 0`，并入现有 schema 版本迁移链——验证：迁移后 pod 内 `pragma table_info(bots)` 含两列，且既有行 `allow_tools=0`、`persona IS NULL`
- [x] 1.2 `db.js` 的 `BOT_COLS` 带上两字段（`allow_tools AS allowTools`、`persona`），`addBot`/`updateBot` 接受并落库——验证：新增单测 round-trip（建 bot 带 persona+allowTools → `getBot` 原值返回；PATCH 只改一项不影响另一项）

## 2. 回合路径（`server/bots.js`）

- [x] 2.1 工具判定收敛为 `allowToolsFor(bot) = 部署上限 && bot.allowTools`，提示词前缀与回复侧 `usedTools` 扣留共用同一函数——验证：`scripts/test-bots.mjs` 三条用例（bot 关 / 上限开+bot 开 / 上限关+bot 开）分别断言「不执行工具」「执行且转发」「不执行」
- [x] 2.2 `runTurn` 的 `isReady()` 早退改为有界等待（新 env `BOTS_READY_WAIT_MS`，默认 90_000，250ms 轮询）——验证：新增用例 ①运行时就绪后到达 → 走完整回合且不出现兜底文案；②预算耗尽 → 回兜底且日志含「等待超时」字样；③等待期间同会话第二条排队不并发
- [x] 2.3 人格块注入到 `blocks[0]`：有 `persona` 用其文本，无则用中性默认（含 bot 名 + 禁止冒充运营者/舰队副驾/内部工具面）；pack bot 的挂技能块顺延到其后——验证：`scripts/test-bots.mjs` 断言无 persona 时首块含 bot 名与禁止语；`scripts/test-pack-bot-units.mjs` 断言人格在前、技能在后

## 3. 管理面

- [x] 3.1 `maskBot` 透出 `persona` 与 `allowTools`（非密钥，不参与 `configuredCredentials`），`POST/PATCH /api/bots` 接受两字段——验证：`scripts/test-bots.mjs` 断言读回值一致且密钥值仍不出现在响应里
- [x] 3.2 bots 编辑表单增加人格输入框与工具开关，五语言文案补齐——验证：`web` typecheck + biome 绿，表单保存后重读回显

## 4. 回归

- [x] 4.1 受影响套件全绿：`test-bots`、`test-wecom-bot-pipeline`、`test-bot-webhook-boot-latch`、`test-user-questions-host`、`test-pack-bot-units`、`test-bot-relay`——验证：逐套跑出全绿输出
- [x] 4.2 导入完整性门 `check-import-integrity` 全解析——验证：脚本 exit 0
- [x] 4.3 `openspec validate --changes --strict` 本 change 绿——验证：命令输出无本 change 的失败项

## 5. 出片与生产

- [x] 5.1 出片（`fd-build-snapshot` 从远端 clone → image workflow 绿 → relay → digest 硬门 → GitOps bump）——验证：ccr digest 与 workflow 产物一致，pod 内 `grep` 到新符号（`allowToolsFor`）
- [x] 5.2 生产 env `BOTS_ALLOW_TOOLS` 处置拍板并执行（摘除=全 bot 禁工具；保留=逐 bot 开 `allow_tools`）——验证：`kubectl exec … printenv` 反映最终口径，`GET /api/bots` 各 bot `allowTools` 符合预期
- [x] 5.3 真机验收（企业微信群）：①发一条 → 得该 bot 自身的答案（非 `starting up`、非决策队列/运营内容）；②滚版后立刻发一条 → 排队后作答而非兜底——验证：pod 日志出现 `inbound` + `replied`，`bot_chats.last_seen_at` 前移，聊天窗可见真实答案
- [x] 5.4 台账 `docs/registry-maintenance.md` 记一条 §（含事故复盘：滚版窗口 + 全局 env 漂移 + 无人格三因叠加）并归档本 change——验证：台账章节可检索到，`openspec archive` 后 `validate --specs` 绿
