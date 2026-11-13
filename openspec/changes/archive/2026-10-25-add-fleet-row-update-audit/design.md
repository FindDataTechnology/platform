# Design — add-fleet-row-update-audit

## Context

复位者定位的困境：应用层排查已穷尽（外科式 update、三写点护栏、PATCH 零条、provisioner
只读），剩下的两条路——进程外裸写库、未知进程内路径——应用层审计都抓不到前者。fleets 库
实况是 better-sqlite3 单文件（fleets-db.js:9），SQLite 触发器在库层无差别生效，恰补这个
盲区。需求原文称「10-22 已切 PG」与本仓代码不符：paas 主库（db.js）与 fleets 库都是
better-sqlite3；若彼时切库发生在别处（如 wire 侧平台库），与本 change 无涉——本设计按
SQLite 落地，PG 化时的改写点在 D2 备案。

## Goals / Non-Goals

**Goals:**

- fleets 表任何 UPDATE（含进程外）都有审计痕；进程内更新可归因到调用方；
- orchestration 复位为 null 的可疑写即时 warn,下次复发凭审计直接定位复位者。

**Non-Goals:**

- 不做写拦截/审批(审计只落痕,不改变任何写的可执行性——先取证,定罪后再谈拦截);
- 不做审计查询 API / UI(运维直查库表,等复发频率证明值得再做);
- 不覆盖 fleet_members 等其他表(复位事故只涉及 fleets 行;扩表是加一行 CREATE TRIGGER
  的事,留给真需要时)。

## Decisions

### D1 双层审计:触发器是地面真相,应用层是归因,配对判读

```
        任何 UPDATE fleets(平台 API / fleet-architect / bash 直写 / 未知路径)
                              │
        ┌─── 库层 AFTER UPDATE 触发器(无差别)───┐
        │  fleet_row_audit: ts / fleet_id /     │   ← 每一笔必落(同事务)
        │  changed_columns / orch old → new     │
        └───────────────────────────────────────┘
                              ▲
        ┌─── 应用层 meta 归因(updateFleet 第三参)┐
        │  actor: HTTP 身份或调用方              │   ← 平台进程内的每笔都有
        │  via: 路由名 / 模块名(栈首帧兜底)      │
        └───────────────────────────────────────┘

判读: 触发器有、应用层无 → 进程外写入(嫌疑①当场裁决)
      两层都有 → caller 直接可读(嫌疑②若存在,自曝)
```

- 备选(否决):只做应用层——恰是抓不到头号嫌疑的方案;只做触发器——有变更无 caller,
  需求第一验收(查到 caller)过不了。
- 备选(否决):复用 wire-provenance-ledger 台账形态——那是 wire 侧产物,跨仓引依赖换不来
  本仓 SQLite 一条 CREATE TRIGGER 能给的东西;action_audit(db.js:786)形态可参考但不
  复用表(action 域与 fleet 行域生命周期不同,混表让判读复杂化)。

### D2 触发器形态与 PG 备案

```sql
CREATE TABLE IF NOT EXISTS fleet_row_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  fleet_id TEXT NOT NULL,
  changed_columns TEXT NOT NULL,        -- JSON array
  orchestration_old TEXT, orchestration_new TEXT,
  actor TEXT, via TEXT                  -- 应用层注入,进程外写为 NULL
);
```

触发器只写 ts/fleet_id/changed_columns/orch old→new(actor 列由应用层路径在同事务补写
或触发器后由 updateFleet 单独 UPDATE 审计行——取**后者**:触发器保持纯库层零依赖,应用层
`UPDATE fleet_row_audit SET actor=?, via=? WHERE id=last_insert_rowid()`,进程外写天然
NULL,判读零歧义)。changed_columns 用触发器内的 `old.x IS NOT new.x` 逐列比较
(better-sqlite3/SQLite 均支持 IS 比较,JSON 列安全)。
PG 化备案:触发器改 PG 规则函数 + `current_setting('app.actor')` 注入归因,应用层
meta 传参不变——本设计的分层就是为这一步免重写。

### D3 updateFleet 第三参 meta,生产 8 调用点清单

`updateFleet(id, updates, meta)` 可选参,缺省行为不变(测试调用点零改动)。生产调用点:

| 调用点 | meta |
|---|---|
| fleets.js:1258(PATCH) | `{ actor: req 身份, via: "PATCH /api/fleets/:id" }` |
| fleets.js:1278(archive) | 同上 via=DELETE |
| fleets.js:841(confirm-start 复活) | via="POST /api/fleets/:id/start" |
| fleets.js:1534(member 删除的 edges 收缩) | via=DELETE members 路由 |
| fleet-architect.js:478/538/544 | `{ actor: ownerEmail, via: "fleet-architect:applyFleetDraft:create/edit" }` |
| fleet-provisioner.js:202(模板落地 orchestration) | `{ actor: fleet.ownerEmail, via: "fleet-provisioner:provisionFleet" }` — 实施时全仓普查补上的第 8 点,初版清单(4+3)漏列 |

未传 meta 的未来调用点:捕获 `new Error().stack` 第二帧塞 via——兜底归因比无归因强,
且栈首帧文字直接指向漏传点(等于免费的 lint)。

### D4 访问日志只挂 /api/fleets 非只读

server.js 挂一条 middleware:`/api/fleets` 前缀 && method ∈ {POST,PATCH,PUT,DELETE}
→ 一行 `method path user-email`。不动全局:现有日志面是刻意收敛的,只为取证开这一个口,
与触发器/应用层审计三方对表。

### D5 warn 判定收窄

只在「orchestration 非 null → null」且「actor 缺失,或 actor ≠ fleet.owner_email 且
via 非 HTTP 路由」时 warn。architect 的 remapOrchestration(478/543)写的是对象非 null、
swap 合并 edges(1505)非 null→null,均不触发——warn 面积收窄到真可疑形态,防狼来了。

## Risks / Trade-offs

- [触发器同事务] UPDATE 回滚则审计行同回滚 → 接受:判读的是「落库事实」,未落库的写
  本就不存在;避免 AFTER 语句级+独立事务的复杂度。
- [审计表增长] 舰队数 × 更新频率极低(人工操作为主)→ 不设清理;备案观察,量级证明
  需要时再加保留窗。
- [进程外写判读依赖两边都工作] → 单测各钉一层:模拟进程外 UPDATE(直接 db.exec)断言
  触发器落行;人为 PATCH 断言归因在——两层独立可验,不赌集成。
- [在途 change 并行] add-mixed-fleet-packs…(另一会话)不碰 agent-fleet-core 与
  fleets-db.js → 无文件冲突;提交纪律照旧只 add 本变更文件。

## Migration Plan

建表与触发器随 createFleetDatabase 的 `CREATE ... IF NOT EXISTS` 幂等建——既有生产
fleets.db 在下次平台启动时自动获得审计能力,无需手工迁移;UPDATE 路径的归因补写对新表
为空操作(无审计行可更)。回滚:镜像回退;审计表与触发器留存无害(纯追加),彻底清除需
DROP TRIGGER/TABLE(不预期)。

## Open Questions

（无。）
