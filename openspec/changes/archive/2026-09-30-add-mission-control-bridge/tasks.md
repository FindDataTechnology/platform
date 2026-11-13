# Tasks: add-mission-control-bridge

## 1. 引擎侧支撑

- [x] 1.1 `createManualTask` 接受 `origin` 透传并随记录持久化/序列化（`origin: { mc: id }`）；clientShape 不外露 — 验证：单测——origin 往返落盘重载仍在

## 2. 桥模块

- [x] 2.1 `server/mc-bridge.js` 骨架：env 门（缺省 inert）、注册、心跳+轮询单循环（5s，错误倍增至 5min，成功复位；timer unref；attach 不阻塞 boot） — 验证：单测——stub console 收到 register 与至少一次心跳/轮询
- [x] 2.2 认领映射：`title=persona`、`description=prompt` 约定；persona 对 roster 校验（未知→向 console 报结构化失败、不建 cell 任务）；`origin.mc` 幂等（重见不重建） — 验证：单测——未知 persona 拒绝 + 同 id 二次认领复用
- [x] 2.3 结果回传：终态→`POST /tasks/<id>/result`（state/output/error/usage）；失败重试（`mcReportedAt` 标记持久化，重启续投）；重试不影响 cell 任务态 — 验证：单测——首次投递失败后下轮补投成功

## 3. 接线与配置

- [x] 3.1 server.js 一行 attach；`.env.example` 四个变量（MC_BRIDGE/MC_URL/MC_API_KEY/MC_AGENT_NAME） — 验证：缺省启动零外联（boot 日志无 mc-bridge 行为）
- [x] 3.2 `DEPLOY.md` 运维手册：cheap-N 尾网 docker compose、MC_ALLOWED_HOSTS、仅运营者/演示 cell 注册、首次部署三端点核对清单 — 验证：文档检视

## 4. 验证

- [x] 4.1 单测 `scripts/test-mc-bridge.mjs`（stub console：http server 实现 register/queue/result 三端点） — 验证：register→queue→claim→failed→result 回传全链路 + 断连退避恢复
- [x] 4.2 e2e `e2e/mc-bridge.spec.js`：自起 cell（stub console）——MC 任务出现在 /tasks（manual 类别、专属 session）、结果落回 console — 验证：spec 绿
- [x] 4.3 回归：现有 cron/delegation/worker 套件在无桥环境全绿；`openspec validate add-mission-control-bridge --strict`；typecheck/lint
