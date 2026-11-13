## Why

网关 `GET /api/{skills,servers,agents}` 的列表契约是**分页的**：默认 `limit=20`，响应体自带
`total_count` / `limit` / `offset` / `has_next`。调用方普遍裸读一次就当拿到了全量，于是
"读取不全"被误读成"注册失败"或"条目不存在"。

2026-10-17 在 `docs/wire-presets/register_skills.py` 上实测到该缺陷的完整形态：技能总数
212，脚本只读 20 条，导致 17 个既有 wire 技能全被判为缺失（8 个重提交被网关 409 幂等兜住），
末段 verification 报 `0/17 registered`——与事实相反。危险不在报错，在于**它看起来像注册
失败**：会诱使操作者重试注册、怀疑网关、或手工补录。

同源缺陷在 paas 生产侧仍然活着：`registry-bridge.js` 给 servers/skills 带了 `?limit=500`，
唯独 `/api/agents` 裸读，实测 23 个 agent 只取到 20 个。按 enabled 口径重算，净用户可见损失
是 **1** 个条目（`/packs/yopQIgU6vZhFNGpGWvUWbw/daas-analyst`，另两个被截断项本就
`is_enabled=false`、会被正常过滤）。该条目本身是孤儿（其 pack 已 404、`num_skills=0`），
所以本 change 的价值**不建立在"救回它"**上，而在于两条长期保证：

1. 条目数越过任何硬顶（`limit=500`，网关上限 2000）时不再静默丢数据；
2. 截断从不可见变为可观测，让运维能在用户察觉前发现读法缺陷。

## What Changes

- `registry-bridge.js` 的三处 registry 列表读取统一为**分页取全量**：读完一页后按 `has_next`
  继续，直到取尽；不再依赖单一 `limit` 数值恰好大于总数。
- 新增**截断防御**：任何列表读取若返回 `has_next === true` 而调用方未继续翻页，SHALL 记录
  告警（含端点、`total_count`、已取条数），使"少读"从静默变为可观测。
- `/api/agents` 补上分页（当前唯一裸读端点）。
- 测试桩补齐 `total_count`/`has_next`/`offset` 信封，并新增一条**多页用例**：总数超过单页
  时，bridge 必须取回全部条目。
- 跨仓待办（不在本 change 的代码范围内，登记为任务以便追踪）：`finddata-skills` 仓
  `scripts/register_skills.py` 仍是裸读版；`docs/wire-presets/register_skills.py` 的分页修复
  需回推到该仓，并修掉其 `--rescan` 分支的 `after_items` NameError。

## Capabilities

### New Capabilities

（无——本 change 收口的是既有 `registry-market-deployment` 已声明行为的实现缺陷，不引入
新的对外行为。）

### Modified Capabilities

- `registry-market-deployment`: 「Deployed market reflects registry content」补一条**完整性**
  要求——registry 列表读取 SHALL 取全量（按分页契约翻页），且 SHALL NOT 因默认页大小静默
  丢弃条目；截断 SHALL 可观测。

## Impact

- 代码：`registry-bridge.js`（`doRefresh` 的三处 fetch、新增分页助手与截断告警）、
  `scripts/test-registry-bridge.mjs`（桩信封 + 多页用例）。
- 行为：分页修正后，此前被截断的 enabled 条目会进入目录（当前实测 1 个，且为孤儿）。
  真正的收益是条目增长越过硬顶时不再静默丢数据——**不是**恢复某个特定角色。
- 风险：翻页会在 refresh 周期内增加请求数（212 条 / `limit=500` 下仍为 1 次；条目越过 500
  后自动多跳，网关上限 2000）。刷新有 single-flight 与 last-good 兜底，失败不清空快照。
- 无 breaking：registry API 契约不变，仅调用方改读法。
- 跨仓：`finddata-skills`（Gitee）与 `finddata/docs/wire-presets/` 的脚本同步不在本仓实施范围。
