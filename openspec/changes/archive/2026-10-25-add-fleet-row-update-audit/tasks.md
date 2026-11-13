# Tasks — add-fleet-row-update-audit

## 1. 库层（触发器 = 地面真相）

- [x] 1.1 `fleets-db.js`：orchestration 迁移段之后幂等建 `fleet_row_audit` 表 + fleets 表
  AFTER UPDATE 触发器（changed_columns 逐列 IS 比较、orchestration old→new、不含
  updated_at 噪声列）。验证：test-fleet-core 新断言——绕过 updateFleet 直接 SQL UPDATE，
  审计行照落且 actor 为 NULL。

## 2. 应用层（归因）

- [x] 2.1 `updateFleet(id, updates, meta)`：可选第三参；UPDATE 后把 actor/via 回填到本次
  产生的审计行（同步单连接 MAX(id)）；orchestration 非 null→null 且非 owner 的
  /api/fleets HTTP 会话 → warn。验证：单测断言归因回填与 warn 触发/不触发两侧。
- [x] 2.2 生产 8 调用点传 meta：fleets.js（confirm-start 复活 / PATCH / archive /
  member 删除的 edges 收缩）+ fleet-architect.js（478/538/544）+ fleet-provisioner.js:202
  （全仓普查补上的第 8 点，初版清单漏列——provisioner 落地模板 orchestration，恰是
  审计要盯的写点）。验证：rg 无裸调用残留
  （测试文件除外），每处 via 指名路由或模块函数。
- [x] 2.3 `/api/fleets` 非只读访问日志：createFleetRoutes 的 router 级 middleware
  （method + path + 身份），GET/HEAD/OPTIONS 不记。验证：代码走查 + 既有 fleet 路由
  测试全绿（middleware 不改变响应语义）。

## 3. 测试与回归

- [x] 3.1 test-fleet-core 扩展：①meta PATCH → 审计行含 actor/via 与 orch 新旧值；
  ②直接 SQL UPDATE → 审计行落、actor NULL；③orchestration 复位 warn 两侧；④常规更新
  行为不变仅追加审计行。验证：`node --test scripts/test-fleet-core.mjs` 全绿。
- [x] 3.2 回归：跑全部 updateFleet 消费方测试（fleet-core / orchestration /
  orchestration-purity / tool-posts / report-lane / turn-events / event-wake /
  bots-event-wake）。验证：全绿输出。


## 4. 生产实证（上产 sha-055def5 后，2026-10-25）

- [x] 4.1 fleet_row_audit 生产首行：PATCH /api/fleets/fleet_1792786329045_jchvsd（同值
  orchestration，零行为变化）→ 审计行 `{actor: platform-test@findmail.com, via: "PATCH
  /api/fleets/fleet_1792786329045_jchvsd", changed_columns: "[]", orch old=new
  supervisor}`——归因与触发器双层都在；同值写不误报变更列。进程外捕获路径由单测覆盖
  （直接 SQL UPDATE → 触发器落行、actor NULL）。
- [x] 4.2 复位者定位语义就绪：下次 orchestration 复位复发时，凭
  `SELECT * FROM fleet_row_audit WHERE fleet_id=?`——actor/via 有值=平台内谁干的；
  actor NULL=进程外写入（首日巡线 bash 裸写嫌疑的唯一落网点）。观察期内每次巡线前照旧
  查 orchestration 字段（fd-wire HANDOFF §2-1），复发即审计定位。
