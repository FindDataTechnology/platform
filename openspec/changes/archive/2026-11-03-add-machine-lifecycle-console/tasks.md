## 1. 存储层（gateway/fleet-machines-store.js）

- [x] 1.1 每行新增 `history`（有界环，封顶 200，最新在前）、`lastSignal`（五元组签名）、`revokedAt` 三字段并给默认值；`load()` 对缺失字段补默认，验证：单测覆盖老文件（无新字段）加载后职责不变、`persist()` 形状含新字段。
- [x] 1.2 在 `touch / recordDetail / recordDesired` 内实现翻转判据与五类事件生成（`presence_flip / desired_change / merge_advance / rejects_flip / divergence_flip`），只在签名变化时入环并 `persist()`；验证：单测钉「同刻态连发 10 拍零新增零写盘」与「每类翻转各记一条、载荷无内容类字段」。
- [x] 1.3 撤销清理与保留：`revoke(deviceId)` 置 `revokedAt`、`clearDesired`、记 `unbound` 历史并写透；`load()` 与写入时惰性清扫「撤销满 30 天整行删除」；`list()` 默认过滤撤销行；验证：单测覆盖撤销后清期望、重配不继承、30 天后行与历史消失。

## 2. 路由层（gateway/fleet-machines-routes.js）

- [x] 2.1 `GET /api/machines/:deviceId/history?limit=`：账号内绑定可读；绑定不存在但 `revokedAt + ownerEmail 匹配 + 30 天内`放行；他账号 404；admin 可见全量；验证：单测四类请求 + 响应最新在前且条数有界。
- [x] 2.2 `DELETE /api/machines/:deviceId`：调 `appAuth.revoke` → store `revoke` → 写透后 200；未绑定/他账号 404；验证：单测「撤销后上报门与拉取门均 401」由既有 door 测试承接，本端点钉存储侧副作用。
- [x] 2.3 读路径沉默翻转补记：`GET /api/machines` 与详情读取派生 `silence` 后与 `lastSignal` 比对，翻转即补记并写透；验证：单测伪造阈值过期后一次名册读取产生恰好一条 `presence_flip`，再读不重复。

## 3. 前端机器页（web/src/pages/MachinesPage.tsx + 设置页）

- [x] 3.1 名册卡渲染 `presence.os / appVersion / boundAt`，缺失显示占位不报错；抽屉标题改 `label || deviceId` 并补配对时刻；验证：组件测试三字段渲染 + 标签回退。
- [x] 3.2 配对向导：页头「添加机器」+ 空态主按钮 → 复用 `GET /api/mp/bindcode` 呈现 6 位码/QR/倒计时/刷新，QR 载荷保持 `/settings/devices?bindcode=` 合约；成功后转等待态按 `boundAt` 晚于铸码时刻识别新机；验证：e2e 空态点击出向导、铸码渲染、等待态收敛为新行（夹具模拟）。
- [x] 3.3 收敛指示器四态（已同步/收敛中/待取令/背离）+ `desiredVersionSeen` 缺失的未知态 + 明细陈旧退化，文案含「机器下一拍来取（≤60 秒）」与沉默诊断指引；验证：派生函数单测四态+两退化 + e2e 至少两态可见。
- [x] 3.4 历史时间线（最近 20 条 + 展开）与解绑危险区两步确认（调 `DELETE /api/machines/:id`，成功后关抽屉刷名册）；验证：e2e 历史渲染与解绑确认流程。
- [x] 3.5 设置页 `DevicesSection` 过滤 `kind==="steward"`（`undefined` 视为 app），补一句机器请到机器页的指路；验证：单测三种 kind 的列表行为。
- [x] 3.6 五语 i18n 键（`machines.pair.* / converge.* / history.* / unbind.*`）全量落地；验证：`scripts/check-locales` 门过，五语无缺键。

## 4. 文档（docs/deploy-and-manage-your-machine.md）

- [x] 4.1 配对步骤改「机器 → 添加机器」，解绑改详情抽屉危险区，名册卡系统信息承诺与新增历史一节对齐实面；验证：逐条对照走查截图/代码，无「词不实」步骤。
- [x] 4.2 桌面扫码实面核实：确认扫码实现所在仓（`electron/` 全树未见），按其结局订正教程扫码步骤或记录挂账；验证：核实记录写入台账，文档不再承诺不存在的操作。

## 5. 验证与收口

- [x] 5.1 单测全家桶：store/routes 新测 + 既有 `test-fleet-machines*` 回归全绿；验证：`node --test` 相关文件 0 失败。
- [x] 5.2 e2e 新支（`machines-lifecycle`）：空态配对向导、收敛两态、历史渲染、解绑确认四段；验证：e2e 全绿并纳入既有 e2e-fast 车道。
- [x] 5.3 `openspec validate add-machine-lifecycle-console --strict` 绿；台账补 §15.x 立案条目；验证：命令输出 0 失败、台账可检索。
