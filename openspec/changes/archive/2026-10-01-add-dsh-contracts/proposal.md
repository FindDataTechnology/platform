## Why

ADR-0007 跟随者策略的剩余缺口：dsh 上游每日一个 lockstep rc、无 stable、latest dist-tag 停在首版，平台对其只能选择何时跟随——但"能不能跟、跟了会断哪"目前靠手工验证（Dockerfile 注释里的历史事故知识：hmr 1.0.17 崩环、peer 缺口 ERR_MODULE_NOT_FOUND、patch 语义）。add-dsh-matrix-lock 已把"装了什么"锁死并上启动硬门；本 change 把"依赖它哪些行为"编码成**可对任意候选安装试跑的断言套件**，让每次版本跟随从惊吓变成一份 CI 报告，支撑每 3-4 周跳最新绿 rc 的节奏政策。

## What Changes

- 新增独立 `dsh-contracts` runner（`scripts/dsh-contracts.mjs` + `npm run dsh:contracts`）：参数为任意 dsh 安装路径（候选模式），在该安装上物化一个临时 profile home、spawn 子进程、完成 initialize 握手、逐条断言合同清单，输出逐条 pass/fail 报告；退出码聚合。
- v1 六条合同（拷问 Q10 定案）：①boot + initialize 握手 + 名册投影；②安装树闭包全量可解析（防 peer 缺口复发）；③cordis-plugin-hmr registerConfig 合同（<1.0.17）；④settings.yaml / .credentials.yaml 热重载（llm-pi-ai 唤醒 + 凭证轮换）；⑤cordis patch disable+insert 语义 + profile scaffold 四文件；⑥platform-sdk-server 握手 + presets/permissions RPC 面 + `permissions/set` 原地改会话（唯一在用的内部 API，钉进断言让上游破坏时可见）。
- 接线：image.yml 冒烟阶段在容器内对 /opt/dsh 跑套件；PR CI 在 dsh-matrix/ 变更时对 scratch `npm ci` 树跑套件。
- v2 备选明确不做（有兜底重启、破坏会显形）：MCP 热切换、skills 目录 Chokidar、flat-module fallback。

## Capabilities

### New Capabilities
- `dsh-contracts`: 平台对 dsh 上游行为依赖的合同套件——候选模式 runner、六条 v1 合同、镜像/PR 两处接线与退出码契约。

### Modified Capabilities
<!-- 无：矩阵硬门（dsh-version-matrix）行为不变，本 change 是新增验证面。 -->

## Impact

- **新增**：scripts/dsh-contracts.mjs（runner 主体）、dsh-contracts 合同断言模块、package.json scripts。
- **接线**：.github/workflows/image.yml 冒烟步骤扩展；ci.yml 增加 dsh-matrix 路径触发（或路径过滤 job）。
- **依赖**：复用 @deepseek-ai/dsh-sdk-client 的 HarnessClient（已在依赖树）；临时 home 物化复用 dsh-profile.js 参数化 writer（add-dsh-matrix-lock D6 落成）。
- **运维**：升级 dsh 的操作规程变为——改 dsh-matrix 意图条目 → 重生成 lock → `npm run dsh:contracts -- <候选树>` → 绿则跟（3-4 周窗口）。
