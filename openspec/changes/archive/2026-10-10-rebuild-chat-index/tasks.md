# Tasks: rebuild-chat-index

## 1. 重建核心

- [x] 1.1 `scripts/rebuild-chat-index.mjs`：多帧 zstd 解码（按 `28 b5 2f fd` magic 分帧，参照 `inspect-live-session.mjs`）→ `transcriptToRows(jsonlText, { workspaceRoot })` 纯函数（用户行 spliced/user 去重、助手行 text||tools 规则、blocks 由 tool/call + tool/result 合成、title/preset/workspace/时间戳派生）——以 `node --test` 断言一个手写小转录的解析结果
- [x] 1.2 老库读取与合并：`--legacy <app.db>` 打开（WAL 回放）→ 按 `owner` 过滤（读 cell 的 `owner-groups.json`）→ 逐会话取更全一侧 → legacy-only 会话照导（含 0 消息会话）；无 `--legacy` 时纯转录重建——单测覆盖"两侧行数比较三分支 + 他人行跳过"
- [x] 1.3 正文归一：复用 `artifact-normalize.js` 的 `normalizeFunctionalRefs`（workspace 根取转录头 `cwd`）——单测覆盖 `data:` URI 命中/未命中、绝对路径改写、散文不动

## 2. 安全闸与报告

- [x] 2.1 dry-run 默认 + `--apply` 开关 + 写前备份（`app.db`/`-wal`/`-shm` → `app.db.bak-<ISO>`）+ 幂等 upsert（`ON CONFLICT(id) DO UPDATE`，消息按 seq）——单测：两次 apply 结果相同、备份文件存在
- [x] 2.2 `--report <path>` JSON 报告：逐会话来源（transcript/legacy/both）、行数、字节数、未识别事件类型集合、legacy-only 计数、疑似活库警告（`-wal` 非空 / `-shm` 存在）——单测断言报告字段
- [x] 2.3 CLI 形态与退出码：`--cell-root` 必填、未知参数报错、dry-run 退出码 0、解析零错误时报告 `errors: []`——`node scripts/rebuild-chat-index.mjs --help` 与一个临时目录端到端跑通

## 3. 对拍测试（钉死同构）

- [x] 3.1 合成 fixture 逐字节对拍：造一份含 text/工具调用/工具错误/子代理回传/spliced 去重的转录 + 其期望 SQLite 行（手写期望值），断言 `transcriptToRows` 输出与期望完全一致——`node --test scripts/test-rebuild-chat-index.mjs`
- [x] 3.2 活标本对拍（可复跑脚本）：对 platform-test cell（`3fdc7b8e8ac03b68`）跑 dry-run 模式，断言其 14 个会话的解析结果与现存库逐行一致（role/content/blocks）——脚本输出 `14/14 match`；此脚本同时作为生产重建前的对拍前置
- [x] 3.3 CI 接线：把 3.1/3.2 纳入 `npm run test:unit` 覆盖范围（3.2 需要 cell 数据，标注为本地/运维手动跑，不在 CI 里执行）——`npm run test:unit` 全绿且 3.1 在其中

## 4. 生产重建与验收（cheap-3 / novel cell）

- [x] 4.1 前置：`fix-cell-spawn-inflight-dedup` 已上线；确认 `2b043ce050ca134c` 只剩一个 cell 进程（`ps` + gateway 日志）——无孤儿进程
- [x] 4.2 停 cell → pod 内 dry-run（`--cell-root /data/cells/2b043ce050ca134c --legacy <拷入的老库>`）→ 核对报告：125 会话（109 转录侧 + 16 legacy-only）、5,104 消息、他人行 4 跳过、`errors: []`、~228 MiB
- [x] 4.3 `--apply` 执行 + 确认备份文件生成；重启后侧边栏 125 行（用户本人浏览器确认）
- [x] 4.4 抽查三个时代各一会话（`--app--` / `--data-workspace--` / 当前 workspace）打开正常、工具块与结果完整；最大会话（307 条 user 消息）打开正常；含交付文件链接的会话点得开（归一函数生效）
- [x] 4.5 用户点名验收会话（如有）逐条打开确认；记录验收证据到 change 报告

## 5. 收口

- [x] 5.1 归档前复跑 `openspec validate rebuild-chat-index --strict` 全绿
- [x] 5.2 报告与经验（含对拍结论、体积对比 8GB→~228MiB 的构成说明）写入 change 目录，供 archive 引用
