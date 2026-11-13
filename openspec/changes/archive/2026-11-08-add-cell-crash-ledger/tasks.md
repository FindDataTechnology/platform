# Tasks — add-cell-crash-ledger

## 1. 台账（数据面）

- [x] 1.1 `gateway/cell-registry.js` 用既有 **guarded-add** 先例加列：`crash_count INTEGER`、
      `last_crash_json TEXT`、`bind_failure_count INTEGER`、`last_bind_failure_json TEXT`
      （`try { ALTER TABLE … } catch {}`，与 `last_gate_refusal_json` 同款）；
      验证 = 用**真实 cell 库副本**跑一次 initDb，老库无报错、列就位、旧行可读
- [x] 1.2 `lib/cell-registry.js` 的 `REGISTRY_SCHEMA_VERSION` 提升并按 `migrateRegistryRow`
      迁移老行（缺列补 null/0，不猜值）；验证 = 老行迁移后形状与新版一致、不丢既有字段
- [x] 1.3 台账读写单测：崩溃计数累加、主动停止不计数、启动失败与崩溃分开；
      验证 = 新增单测覆盖三条断言 + 既有台账单测全绿

## 2. 崩溃路径（spawner）

- [x] 2.1 `gateway/spawner.js` 的非预期退出分支落账（`code`/`signal`/`at`/`uptimeMs`）；
      验证 = 测试里让 child 以非零码退出，断言 `crash_count+1` 与 `last_crash_json` 内容
- [x] 2.2 `bindFailed` 分支落账到启动失败计数；验证 = 起不来的 cell 只增启动失败计数
- [x] 2.3 反复崩溃的**退避（可配置）**：`CELL_CRASH_BACKOFF_BASE_MS`(1000) /
      `CELL_CRASH_BACKOFF_MAX_MS`(**15000**) / `CELL_CRASH_WINDOW_MS`(10min) /
      `CELL_CRASH_REHAB_MS`(10min)；respawn 前延迟，日志点名该 cell；
      验证 = 延迟随次数指数增长、到顶不变，且始终会尝试（不硬拒）
      - 上限取 15s 的理由：唤醒本身 8.6–12s，15s 上限把最坏体感压在「比冷启稍慢」而不是「像坏了」；
        要更护集群就把 `CELL_CRASH_BACKOFF_MAX_MS` 调大，不改代码
- [x] 2.4 康复归零：连续正常运行超过窗口后 `crash_count` 清零、`last_crash_json` 保留；
      验证 = 单测注入时间推进

## 3. 观测面

- [x] 3.1 内存面 cell 行带 `crashCount` / `lastCrash` / `bindFailureCount`，非管理员只见自己 cell；
      验证 = 面返回含字段 + 既有 owner scoping 单测不破
- [x] 3.2 `/healthz` 增 `cellsInError`（不影响 200）；验证 = 有错误态 cell 时计数变化、状态码不变
- [x] 3.3 拒醒记录与崩溃一并可读（`lastGateRefusal` 已在台账，只需在面上带出）；
      验证 = 面返回含该字段

## 4. 上产与验证

- [x] 4.1 出片（`fd-build-channel` 判路 → 公开仓线）并滚 fd-prod；验证 = `tools/verify-rollout.sh platform` 通过
- [x] 4.2 真机验证：故意让一个测试 cell 崩溃一次（测试号），确认台账计数、内存面字段、
      `/healthz` 计数三处一致；验证 = 三处数字对得上，且该 cell 随后仍能正常唤醒
- [x] 4.3 记录基线：把「过去 24h 崩溃次数」从新台账读出来写进 `docs/registry-maintenance.md`，
      作为「要不要动崩溃域」的判据；验证 = 台账有数、文档有引用
      - 真机实测（2026-11-08，`platform-test` cell 被 SIGKILL）：`crash_count 0→1`、
        `last_crash_json = {"code":null,"signal":"SIGKILL","at":1794127252597,"uptimeMs":122532}`、
        `/healthz cellsInError=1 crashTotal=1`、内存面 `crashCount=1 lastCrashSignal=SIGKILL`；
        该 cell 仍 `state=suspended / policy=on_demand / destroy_reason=null`（可唤醒，未被锁）
      - 台账起点：截至实测时点，**除本次人为注入外历史崩溃数 = 0**（`crash_count>0` 的 cell 仅这 1 个）；
        真实基线需等台账跑满日常负载后再回看
