# add-fleet-owner-iteration · tasks

## 1. 配置改动提议型拍板项（agent-fleet-decision-lane delta）

- [x] 1.1 `decision_items` 类型扩展：`item_type`+`detail` 列（旧行零差异）+提议型拍板项（detail 带 diff/changes/proposedBy）+「批准前零生效」测试断言
- [x] 1.2 提议入口 `POST /:id/iterations/propose`：summary/changes 必填校验，落入既有拍板队列（ddeposition+options 形状与 validateResolution 同源）
- [x] 1.3 批准回调：`/:id/decisions/:itemId/approve` 链接 config-change → `runIterationCast`；结论先行入审计、失败不翻盘、iteration 行记轴；回调结果随响应附 iteration 键（additive）

## 2. 铸版发版链

- [x] 2.1 `fleet_iterations` 状态机表（proposed→approved→casting→publishing→published|failed(axis)）+状态读面 `GET /:id/iterations`
- [x] 2.2 编排器：现役 export（白名单字段）→继承原 manifest 合并 → 同 packId 新主版本；链首环 validate-only 预检（测试断言未过不碰发布预算）
- [x] 2.3 失败轴透传（validate/publish/unhandled 分轴）+从失败环重试 `POST /:id/iterations/:id/retry`（published 幂等、proposed 呼应被拒）
- [x] 2.4 发布语义与署名/价格规则同轨：附体身份走 /api/packs 人工同缝（cookie 转移注入面），iterationsPublisher install/validator 慥同注入使测试可证；市场规则未在链上开任何侧门

## 3. 跟新提示（pack-marketplace delta）

- [x] 3.1 `GET /api/packs/subscriptions/updates`：订阅主体×新主版本的最新行（name/版本/发布时间/notes），未订阅主体不见
- [x] 3.2 坞面 chip「新版 vn」按 sourceTemplate 并联 (OwnerBoardStrip), 带 notes title；不自动升级断言=读面为纯查询，无任何升装动作
- [x] 3.3 templateNotice 强化=经营面坞落位（见 spec 补充注记——cockpit 只可读不改面, 「新版可用」语义无歧交叉于坞面 chip；不变更既有 manifest 字段）

## 4. 报数 digest 订阅

- [x] 4.1 `fleet_digest_subscriptions` 表+REST（POST subscribe/DELETE/Digest list owner 可见）
- [x] 4.2 `renderDigest` 决定性渲染（open 拍板计数+每岗槽位+未报+24h 花销投影），跟随「不虚构」纪律；停机补跑=last_run_at/last_sent_at 事实源+tick（boot 即连）
- [x] 4.3 账内 unread 投递：`fleet-digest:<subId>` 会话 recordMessage（owner=订阅者）抬 updatedAt 即出 unread 语义（spec 同语义源—— session last-updated 派生）+窗口克制+退订即止测试

## 5. 收尾

- [x] 5.1 `openspec validate add-fleet-owner-iteration --strict` 全绿
- [x] 5.2 商业口全链自证走查：提议→拍板→vN+1 上架→updates 提示→现役集群零触动→digest 按档送达；失败路径（未参负载/validate轴/publish轴/回调不翻盘）如实——6 件测试全部覆盖；真机 PCA 与同棒同窗挂账
- [x] 5.3 web typecheck 全绿（fleet-owner-api 迭代/digest 块/OwnerBoardStrip 交互）

## 实施注记（2026-10-27→28 起棒实录）

- 落件：`server/fleet-iteration.js`(新, 提议/铸版/重试)、`server/fleet-digest.js`(新, 渲染+调度+投递)、`server/routes/fleets-db.js`(item_type/detail+iterations+digest 表)、`server/routes/fleets.js`(提议/迭代/digest 路由+批准回调+默认运输注入面)、`gateway/packs.js`(subscriptionsFor+updates 端点)、UI(fleet-owner-api/OwnerBoardStrip/locales)、`scripts/test-fleet-owner-iteration.mjs`(6/6)。
- 设计落字：审批单=类型扩展的拍板项 (decision_items), 不建第二张表；digest=决定性渲染+interval tick 调度器写入账号会话（cron-engine 作业=LLM 回合语义，本 digest 的「不虚构」纪律迫使走决定性窗渲路径——写进了注记防回退）；跟新=查询读面纯交通，已装内容零升级（discipline 只允许显式动作）。
- 挂账：①PCA 真机全真旅程与 vendor 4.2 同窗；②四棒共享区(packs.js 多线在途)统一合流提交；③外发推送通道（邮件/IM）=v2 意向，账内 unread 通道即本版终态。
