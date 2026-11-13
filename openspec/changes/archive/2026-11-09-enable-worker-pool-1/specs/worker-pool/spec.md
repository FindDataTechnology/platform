## MODIFIED Requirements

### Requirement: The pool is bounded and degrades gracefully
The pool size SHALL NOT exceed `TASK_WORKER_MAX`. At 0 the pool is inert — every execution runs on the primary slot with today's serial semantics (queue behind the active turn, persona switch before prompting). The value MAY be set per deployment; unset defaults to 0. A non-zero cap SHALL only be set where the cell's memory limit clears the wake-admission gate (`used + cell footprint` ≤ `limit × (1 − CELL_MEMORY_ADMISSION_FLOOR)`), because each worker is a second dsh bridge inside the same cell and a refused wake is a silent stall.

#### Scenario: Cap zero is today's serial behavior
- **WHEN** the cell runs with `TASK_WORKER_MAX=0`
- **THEN** task executions run on the primary slot exactly as before this capability, one at a time, queueing behind the live turn

#### Scenario: Cap is never exceeded
- **WHEN** many tasks for distinct personas are due simultaneously and the cap is N
- **THEN** at most N workers exist, and remaining tasks queue

#### Scenario: 开池前先过内存准入

- **WHEN** 部署把 `TASK_WORKER_MAX` 从 0 提到非零
- **THEN** 该 cell 的 `used + 足迹` 必须先小于 `limit × (1 − 0.15)`，否则唤醒被拒、池空转（2026-11-08 在 4Gi 上限下的实测形态），不得开池

