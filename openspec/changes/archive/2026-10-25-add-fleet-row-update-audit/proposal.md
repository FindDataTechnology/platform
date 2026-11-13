# add-fleet-row-update-audit

## Why

运营号舰队（fleet_1792786329045_jchvsd）的 orchestration 两次被复位为 null（10-24 首日
+ 当日 13:53 报数实证），复位者未定位，巡线派发边因此消失。静态排查已穷尽且结论可复用
（updateFleet 是外科式更新、三个 orchestration 写点全有护栏、复位窗口对 /api/fleets 的
PATCH 为零条、fleet-provisioner 对既有舰队只读），剩余嫌疑只剩①进程外 bash 裸写 sqlite
（首日实录里巡线岗曾这么读过 fleets.db，同通道写不留任何应用日志）与②未发现的进程内
路径——都需要**运行时证据**才能定位。本 change 落审计设施，复发即定位。

实况修正：fleets 库是 better-sqlite3 单文件（server/routes/fleets-db.js:9，
`fleets.db`），交接需求原文「10-22 已切 PG」与本仓代码不符——这反而是机会：SQLite 的
AFTER UPDATE 触发器能在**库层**捕获任何进程的写入，恰是嫌疑①唯一能落网的位置。

## What Changes

- **库层触发器（地面真相）**：fleets 表 AFTER UPDATE 触发器落 `fleet_row_audit`
  （ts / fleet_id / 变更字段集 / orchestration 旧值→新值）——对任何写入进程无差别生效，
  包括平台进程外的直接 SQL。抓不到「谁」，但每一笔都落。
- **应用层归因**：`updateFleet` 可选第三参 `meta`（actor / via）；生产调用点（fleets.js
  四处、fleet-architect 三处）传入 HTTP 身份或调用方名；未传时捕调用栈首帧默认归因。
- **判读口径**：触发器有、应用层无的那笔 = 进程外写入——嫌疑①当场坐实或排除。
- **访问日志**：`/api/fleets` 非只读方法的 middleware（method + path + 身份）——现状
  server.js 无任何访问日志，复位窗口 PATCH 零条的结论今后可自查。
- **warn 加固**：orchestration 从非 null 变 null 的写，若归因不是该 fleet owner 的
  HTTP 会话，打 warn 日志。

### 不做

- 不迁移 PG（与需求原文的认知差异备案于 design；若未来切 PG，触发器改写为 PG 规则，
  应用层归因不动）；
- 不改 updateFleet 的写语义与三道既有护栏（外科式更新维持原样）；
- 不做全量 HTTP 访问日志（只挂 fleet 面，控制日志面）；
- 审计表不对外 API、不进 dsh 投影（纯运维取证面）；
- 不预设复位者结论——审计是取证设施，判读等下次复发（本 change 的唯一真验收）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `agent-fleet-core`: ADD「舰队行更新落双审计痕」——fleets 表每次 UPDATE SHALL 落
  审计行（库层触发器、无差别捕获进程外写入），进程内调用 SHALL 附归因，orchestration
  复位为 null 且归因非 owner 会话 SHALL 打 warn，/api/fleets 非只读请求 SHALL 记访问
  日志。

## Impact

- `server/routes/fleets-db.js`：fleet_row_audit 建表 + AFTER UPDATE 触发器（随
  createFleetDatabase 幂等建，既有 fleets.db 下次启动自动获得）+ updateFleet 第三参；
- `server/routes/fleets.js`：四个 updateFleet 调用点传 meta（PATCH / archive / 复活 /
  swap 合并 edges）+ /api/fleets 访问日志 middleware；
- `server/fleet-architect.js`：三个调用点传 meta；
- 单测：scripts/test-fleet-core.mjs 增审计断言（人为 PATCH 可查 caller 与新旧值、
  模拟进程外 UPDATE 触发器仍落行）；
- 与在途 `add-mixed-fleet-packs-and-market-consolidation` 无冲突：其 spec delta 覆盖
  pack-marketplace / agent-fleet-orchestration / pack 系 / vertical-packs，不碰
  agent-fleet-core，也不碰 fleets-db.js。
