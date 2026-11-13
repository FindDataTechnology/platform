# fix-runner-port-collision — Tasks

## 1. runner 侧隔离

- [x] 1.1 `agent-runner/manager.js` #ensureListener 挂 server error 处理：EADDRINUSE/其他 listen error → 释放 listeners 条目 + 指名 warn（agent/端口/修复指引），不崩进程——单测：模拟占用端口后 reconcile 新 agent，进程存活、既有 agent 监听不受影响、警告指名
- [x] 1.2 warn 节流 per key（5 分钟）——单测：连续两次 reconcile 同一占用 agent，第二次不重复 warn；节流只压日志，重试绑定照常

## 2. deploy 侧可见性

- [x] 2.1 `lib/agent-serving.js` 占用图列表 catch 加指名 warn（碰撞检测退化）——单测：registry 列表抛错时部署继续（纯哈希）且告警在案

## 3. 回归与出片

- [x] 3.1 全量相关套件绿（agent-runner test workspace + agent-serving + 既有端口碰撞测试组）——`fd-build-channel` 判路出片，platform 三面 + agent-runner-serving 滚 tag，生产实证：runner 滚动后 16 agent 全部 serving、无 crash
