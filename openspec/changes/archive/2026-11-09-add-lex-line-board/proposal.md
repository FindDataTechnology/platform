## Why

finddata `line-onboarding-contract-v2`（B2 主件）交付了七层线接入规约 v2、只读自检门与 lex 知识层（操作 pack `lex-surface-orientation` 已上架 `bYnUd79CqGEHXb79cWDKGg` v1）。七层 L7 呈现层的最后一块缺口是 `/boards/lex`：paas `line-boards` spec 要求「每条已接入产品线一块看板」，现 ADAPTERS 只有 facet/wanxing/wire 三线；lex appCenter 卡片徽标 `early` 按章程 Q3 拍板「跟随看板机制」——看板上线即升 `live`。本单是 B2 tasks §5 的 paas 侧姊妹单（索引单），交付后 B2 门对 lex 的 L7 检查转 PASS。

## What Changes

- `/boards/lex` 适配器（`lib/board-adapters.js` ADAPTERS 注册 + `LexBoardAdapter` 四块，形状照 wire 四块模板）：
  概览（账户：me/usage/quota 三读，lex-ops 同源客户面接口）、我的凭据（`lex_credentials_list` 列表：名称/状态/到期）、
  套件（六套件矩阵自 `lex_surface_overview` 静态事实）、账单（`lex_billing` 时间线；**端点核实后缺读面则该块诚实降级「建设中」**，D3/Q1 拍板不阻塞交付）。
- appCatalog lex 徽标 `early` → `live`（与看板同 commit，回滚一并还原）。
- 六语词条（board 页标题/块标题/空态/降级文案，zh 主轨 + en/日/韩/西/法德葡按既有词条机制）。
- spec 增补：`line-boards` 三条 lex 需求 delta（直读客户面数据 / 凭据态诚实呈现 / 每块原站深链——照柏讯三条同形）。

## Capabilities

### Modified Capabilities

- `line-boards`：+3 REQUIREMENTS（lex 看板直读客户面数据——经用户 lex 凭据直读 lex.finddatatech.cloud 客户面接口，与 lex-ops-mcp 同源不同通道，禁触发模型回合/禁耗 token；凭据态诚实呈现——未连接显示连接引导而非空块；每块保留原站深链）。

## Impact

- `paas/lib/board-adapters.js`（LexBoardAdapter + ADAPTERS 注册）
- `paas/web/src/lib/appCatalog.ts`（lex badge `early`→`live`）
- `paas/web/src/i18n/*`（六语词条）
- `paas/openspec/specs/line-boards/spec.md`（archive 时 +3 requirements）
- 不触碰：boards 路由骨架（`server/routes/boards.js` 既有 `:line` 通配已覆盖新线）、其他线适配器、W2/走查两单在途工件。
- 验证：B2 门 `--line lex` L7 转全 PASS；spec 场景走查落档；lex 徽标线上 live。
