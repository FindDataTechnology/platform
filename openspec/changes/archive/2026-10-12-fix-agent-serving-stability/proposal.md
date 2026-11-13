# fix-agent-serving-stability

## Why

柏讯接客线（wire 会话）移交了三个生产实锤的 bug，病根都在 paas 侧的服务链上：門面把 runner 的任何错误包成 -32032 返给调用方，但调用方真正要的是「工单可靠送达 agent」。三个病灶各自独立复发——幂等缓存会把错误答和重置工单后的旧成功答原样重放（看起来成功、实际没送达）；runner 冷启动失败的子进程泄漏无回收；pack 物化对属主零约束，仓库 compose 仍钉 root 形状，按仓库文件重建 runner 即回到混合属主陷阱。2026-10-12 探索核查三件全部在代码坐实（含 cheap-1 上机实证），其中①②的生产急症已随昨夜 00:27 的 runner 重建（uid-1000 形状 + 驱逐修复 1eb2ae8）暂愈，但代码防线缺失，复发条件仍在。

## What Changes

- **③ 門面幂等缓存（wanxing-facade）**：错误结果永不重放——同键重试直接重新执行并覆写台账行；成功结果的重放绑定请求体指纹（sha256 of rpcBody），同键不同体返回结构化 409 重用错误（Stripe 语义），不再静默重放；24h 保留窗口仅作外层上限。contextId 的 idemKey 派生不动（体异已在执行前被 409 挡下）。
- **② 冷启动失败残余（agent-runner）**：initialize 失败路径关闭已 spawn 的 dsh 进程（当前局部引用丢弃、进程泄漏 100-200MB/次）；INIT_RETRIES 烧尽后由 manager 做带退避的整进程重建升级（杀掉重来，上限后抛可辨识的永久错误），不再只抛一次了事。驱逐修复（1eb2ae8）已在产，本 change 补齐它没盖住的两块。
- **① 物化属主防线（agent-runner）**：仓库 docker-compose 默认从 `user: "0:0"` 改为 uid 1000（对齐生产现实与镜像默认），附迁移注记；`materializeAgentHome` 增加属主守卫——home 根存在外部属主时，root 进程按配置目标 uid 递归 chown 并留痕，非 root 进程响亮报错并给出修复指令，不再等 agent EACCES 变砖后才被发现。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runner`: 新增两条需求——物化 home 必须落在运行身份可读的属主上（含 compose 默认形状）；冷启动失败必须零残留（无孤儿进程、无 map 残留）且带退避重建升级。
- `wanxing-facade`: 「Idempotency-Key deduplicates turns」需求收紧——错误结果不可重放、成功结果重放需请求体指纹匹配、键重用（同键不同体）显式拒绝。

## Impact

- 代码：`gateway/wanxing/core.js`（idempotentSend/idempotencyState）、`gateway/wanxing/store.js`（request 行加 request_hash 列，SQLite 迁移）、`gateway/wanxing/a2a.js`（409 分支）、`agent-runner/child.js`（initialize 失败 close + 重试升级钩子）、`agent-runner/manager.js`（spawn 失败路径升级）、`agent-runner/compose.js`（属主守卫）、`agent-runner/docker-compose.yml`（uid 默认）。
- 兼容性：幂等行为对外可观察变化——同键不同体现在 409（此前 200 重放旧答）；错误答重试现在重新执行（此前 200 重放错误）。均为修复意图本身。
- 部署：单一 platform 镜像承载全部三件（GHA→TCR→GitOps 标准线）；runner 侧随镜像重建生效；門面侧随 fd-prod 滚动生效。store 迁移需兼容既有 wanxing_requests 表（ALTER 增列）。
- 运维：fleet 新 runner 接入配方需同步 compose uid 默认变化的说明。
