# Proposal: adopt-yongyi-client-sdk

## Why

永忆完整解决方案已落地（finddata 根 `add-yongyi-complete-solution`，2026-11-07 apply 33/34）：壹座侧的通用记忆智能（注入阶梯、纪律文本、五类事实捕获、令牌铸造缓存）已下放为独立 npm 包 `@finddatatechnology/yongyi-client`，且以字节同源金样与壹座现役实现直比验收。但壹座与 agent-runner 仍各持一份自有拷贝在跑——同一逻辑三处宿主，从今天起漂移只会在壹座侧发生。配对收口：壹座变薄，成为永忆「最深旗舰客户」的正确形态——消费 SDK，不再自持通用件。

## What Changes

- **依赖接入**：`@finddatatechnology/yongyi-client@^0.1.0` 进 package.json。前置=SDK 先行发布 npm（MIT、永久免费定位的自然动作，发布动作本身需 owner 批准）；file:/git 直引被否（CI 构建不可解析仓外路径）。
- **消费面重接（10 文件，纯 import 换源）**：`server.js`、`dsh-profile.js`、`resources.js`、`server/ws.js`、`server/cron-runner.js`、`server/fleet-cost-digest.js`、`gateway/zhiyu/index.js`、`server/routes/fleets.js`、`server/routes/memory.js`、`server/routes/resources.js` 改从 SDK 取 ladder / discipline / facts / tokens；env 语义（`CELL_MEMORY_*`）与 fail-open 契约逐字节不变（SDK 默认值与壹座现役一致，金样钉死）。
- **删除通用拷贝（6 文件）**：`cell-memory.js`、`memory-discipline.js`、`server/fleet-memory.js`、`server/cluster-memory.js`；agent-runner 侧删 `memory-mount.js`（4 导出中 3 件经任务 1 先补进 SDK）、`memory-discipline.js`，经 SDK 取件。`agent-runner/memory-capture.js` **保留**——它是 runner→fd-memory `/capture` 旧面的批量队列客户端（2s flush/100 批/退避），与 SDK observe 单发即弃语义不同属，不互换（缺口审计修正，见 design D3）。
- **明确保留（paas 特有，不下放也不删）**：`server/memory-refs.js`（资料库薄索引页——壹座统一记忆与产出概念，非通用件）；`server/routes/memory.js`（cell Express 代理面——person 令牌铸造在服务端、浏览器不见 token，壹座铁律）；runner 侧挂载行生成（dsh/acp 两形状的组装接缝留在 runner，原料改取 SDK；SDK 覆盖缺口以任务 1 的审计为准，缺则先补 SDK 小版本）。
- **测试重指向**：`test/cell-memory.test.mjs`、`test/cluster-memory.test.mjs`、`test/dsh-profile-memory.test.mjs`、`agent-runner/test/memory.test.mjs` 从「测自有实现」改为「测接线产出与既有金样逐字节一致」——行为断言主责移交 SDK 自有 55 测试，壹座只钉「接对了」。
- **Portal 决定（推翻 tasks 7.3 的简写）**：壹座 `/memory` 页**保留原生 React 实现**，不改嵌 fd-memory vanilla Portal。理由：①嵌入须把 person 令牌交给浏览器（postMessage 引导），违反壹座「secrets stay server-side」铁律；②原生页在壹座设计系统与五语检查内，独立 Portal 在永忆品牌内，二者是品牌/UX 分层不是逻辑漂移——数据面本就共享；③避免为零行为收益反改 fd-memory spec。壹座 `/memory` 页尾加一行独立 Portal 指引（自托管/其它 harness 用户的人面）。

**Non-goals**：壹座旗舰深度三线程（平台担保捕获全表面化 / 记忆可感 UX / 状态层合一）另立 change；Dify/Coze 与框架 SDK 适配（永忆侧后续波次）；任何记忆语义行为变更（本 change 纯接线替换，零 spec delta）。

## Capabilities

### New Capabilities

（无——纯重构接线，外部可见行为零变化。）

### Modified Capabilities

（无——12 个 memory spec 的需求行为在本 change 下全部不变：SDK 金样保证字节同源。故本 change 以 `skip_specs: true` 过 validate。）

## Impact

- `package.json`：+1 依赖（`@finddatatechnology/yongyi-client`）
- 删除 7 个通用拷贝文件；10 个消费文件换 import 源；4 个测试文件重指向
- 前置外部动作：npm 发布 `@finddatatechnology/yongyi-client@0.1.0`（fd-memory 仓 sdk/，owner 批准后执行）
- 风险与钉子：字节同源以 SDK 仓 4 金样 + 壹座 4 重指向测试双面钉死；agent-runner 挂载行覆盖缺口在任务 1 审计中显式清点
- 归档联动：本 change 立起后，finddata 根 `add-yongyi-complete-solution` 的 tasks 7.3 兑现，该 change 即 34/34 可归档
