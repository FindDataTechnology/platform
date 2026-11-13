## Context

See proposal.md — Why. 现有地基（全部已核实）：

- **路由**：`gateway/fleet-machines-routes.js` 只注册三件——`GET /api/machines`（名册，
  steward binding 为基底）、`GET /api/machines/:deviceId`（detail+desired+health）、
  `PUT /api/machines/:deviceId/desired`（整集替换）。网关与单进程 server 共用同一实现。
- **存储**：`gateway/fleet-machines-store.js` 是平台级 JSON 文件店（原子 temp+rename、
  串行化 mutation），每设备一行：`lastSeenAt / presence / detail / desired / divergenceStreak`。
  仅 `desired` 写透（自愈不了），`touch/recordDetail` 只在内存（下一拍会再来）。
- **上报门**：`gateway/cell-report.js` 深白名单 `sanitizeDetail` 保留
  `merge.desiredVersionSeen`（机器已消费的期望版本）——收敛判断的数据**已在盘上**。
- **机器页**：`web/src/pages/MachinesPage.tsx`（382 行）取到了 `presence.os/appVersion`
  与 `boundAt` 却零渲染；详情抽屉标题是裸 `deviceId`；无配对入口、无解绑、无历史。
- **配对**：铸码 `GET /api/mp/bindcode`（与设置页/小程序共享池），撤销
  `DELETE /api/app/bind/:deviceId`；设置页 `DevicesSection` 列全部绑定（含 steward）。
- **教义**（主 spec「明确不做」）：平台永不发起连接；期望生效唯一路径 = 机器拉取 + 本地收敛。

## Goals / Non-Goals

**Goals:**

- `/machines` 成为 steward 机器唯一生命周期面：配对、名册、详情、收敛、历史、解绑闭环。
- 收敛状态可见：把已上报的 `desiredVersionSeen` 与云端版本比出四态，替代「唤醒」假动作。
- 每机有界元数据历史（上下线/期望审计/收敛结局），翻转才写盘。
- 零控制回程、零新增依赖、零数据库；响应只做加法，旧客户端不受影响。

**Non-Goals:**

- 不做拉取侧「立即取令」nudge（P2 缓拍）——本 change 不动 `steward-reporter.js` 与拉取门。
- 不做桌面扫码实现的补齐或订正（待核实项，文档侧单列）。
- 不做跨机器聚合分析、告警通知推送、历史导出（后续按需）。

## Decisions

### D1 管理面按 kind 分家，而不是搬家后重复

机器页提供 steward 的列表/配对/解绑；设置页 `DevicesSection` 过滤
`kind==="steward"`（`undefined` 视为 `app`，兼容旧绑定）。撤销端点两处共用
`DELETE /api/app/bind/:deviceId`，机器页额外挂 `DELETE /api/machines/:deviceId`
薄包装：先 `appAuth.revoke`，再 `machines.clearDesired` + 记一条 `unbound` 历史 +
写透。

- 备选：把设置页整个删掉——否，app 类设备（手机/小程序）还要在这里管；也避免动
  `device-pairing-auth` 的既有端点契约。
- 备选：机器页也自己列全部绑定——否，会让 steward 两处可撤销，违背「一个心智一个面」。

### D2 历史住在既有 JSON 店的有界环里，不当事件流

每行新增 `history: Event[]`（最新在前，封顶 200 条）与 `lastSignal`（翻转判据）。
事件形状统一：`{ at, kind, ...payload }`，kind ∈ `presence_flip | desired_change |
merge_advance | rejects_flip | divergence_flip`。生成点全部落在 store 的三个写入方法
（`touch / recordDetail / recordDesired`）——只有这里能看见「前值」，路由层看不见。
`persist()` 只在事件真正入环时调用（心跳零写盘）。

- 备选：独立 events 文件 / SQLite——否，平台级状态按既有约定走 JSON 店；cell 库隔离，
  网关不跨库；独立文件只会多一个需要对齐原子性的写点。
- 备选：不封顶、按天数——否，无界 JSON 会随心跳膨胀；200 条 × 机器数足够回看。

### D3 翻转判据 = 签名比较，而不是「有上报就记」

`lastSignal` 存五元组：`silence`（online/silent/never_reported）、`desiredVersion`、
`seenVersion`、`rejectSignature`（rejects 的 `agentPath:code` 排序后拼接）、
`divergenceVerdict`（0 / >0）。每次写入算新签名，逐项比较，翻哪项记哪类。
`never_reported → online` 记 `presence_flip`；`online → silent` 记 `presence_flip`
（沉默由读取时派生也要落史——见 D4）。

### D4 沉默翻转必须由读取侧补记

`silence` 是读时派生（`now - lastSeenAt > threshold`），没有写入事件。做法：
`GET /api/machines`（以及 detail 读取）在派生后若发现 `silence` 与 `lastSignal`
不同，同步补记 `presence_flip` 并写透。读路径产生写是刻意的——它记录的是「观测到
沉默」这一事实；不加锁，`persist()` 队列天然串行。

### D5 收敛四态是纯前端派生，不新增 API 字段

输入：`desired.version`（云端）、`detail.merge.desiredVersionSeen`（机器）、
`detail.at`（样龄）、`health.silence`。规则见 spec。`desiredVersionSeen` 为 `null`
（机器未回报合并信息）时显示**未知态**「机器未回报消费版本」，不得冒充已同步。
不做后端派生下发——避免同一判断两处实现分叉。

### D6 解绑后的行与可读性

撤销不删 store 行：置 `revokedAt`，名册（含 admin 视图）过滤 `revokedAt` 行；
历史读取在「绑定不存在」时回退到 `revokedAt + ownerEmail 匹配 + 30 天内」放行，
否则 404。`load()` 与每次写入做惰性清扫：撤销满 30 天的行整行删除（含历史）。
未撤销机器的事件按 200 条封顶滚动淘汰。

### D7 配对向导复用铸码池，QR 契约不动

向导直接 `GET /api/mp/bindcode`（同一池、同一 5 分钟生命周期），QR 载荷保持
`<origin>/settings/devices?bindcode=<code>`——扫码方按参数取 origin+code，路径不参与
语义；改路径会打碎既有扫码方。铸码后轮询 `GET /api/machines`，出现新 deviceId 即收场
（首次报到前名册已有 binding 行，只是「未上报」——以 `boundAt` 晚于铸码时刻判定新机）。

### D8 文档与 i18n

`docs/deploy-and-manage-your-machine.md` 的配对步骤改为「机器 → 添加机器」，解绑改为
抽屉危险区，补历史一节；扫码步骤待核实后订正。新增键挂 `machines.pair.* /
machines.converge.* / machines.history.* / machines.unbind.*`，五语全量。

## Risks / Trade-offs

- **[历史写放大]** → 只在翻转写盘 + 200 条封顶 + 惰性清扫；单次翻转一次原子写，量级与
  既有 `recordDesired` 同级。
- **[读路径写盘]** → 只发生在沉默翻转（每机每沉默期一次），不是每次读；写队列串行，
  不阻塞响应（`void persist()`，与既有写法一致）。
- **[撤销后历史可读的权限缝]** → 明确判据 = `revokedAt` + `ownerEmail` 匹配 + 30 天；
  他账号恒 404；admin 视图不受限但带 `isAdminView` 语义。
- **[旧网关读新文件]** → 未知字段（history/lastSignal/revokedAt）被旧代码忽略；回滚安全。
- **[前端四态误判]** → `desiredVersionSeen` 缺失时显示未知态；`detail` 样龄超阈值时
  指示器退化为「明细陈旧，状态未知」，不猜。
- **[设置页过滤误伤]** → `kind` 缺省按 `app` 处理，老服务器行为不变；单测钉三种 kind。

## Migration Plan

纯加法：store 字段有默认值（`history=[]`、`lastSignal=null`、`revokedAt=null`），
无 schema 版本、无数据迁移；路由只新增两个端点；前端发版即生效。回滚 = 回退镜像，
盘上多出的字段被旧代码忽略。

## Open Questions

- 桌面扫码实面：`electron/` 全树未见扫码实现，公开教程的「扫码」步骤需核实是文档超前
  还是实现缺位——只影响文档订正，不阻塞本 change。
- 设置页是否加一句「机器配对请到机器页」的指路（纯文案，apply 时可随手定）。
- 历史保留期 30 天为产品默认，若后续要按账号配额调整再议。
