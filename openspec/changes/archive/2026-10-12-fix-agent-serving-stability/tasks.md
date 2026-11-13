# tasks — fix-agent-serving-stability

## 1. 門面幂等缓存（③ wanxing-facade）

- [x] 1.1 store 迁移：`wanxing_requests` 增 `request_hash TEXT` 列（PRAGMA table_info 幂等守卫 + ALTER TABLE），`requestStart`/`requestFinish` 增带指纹的签名重载（旧签名兼容）。验证：`node scripts/test-wanxing-bookkeeping.mjs` 全绿 + 旧库文件直开二启不崩。
- [x] 1.2 core.js `idempotentSend`：error 行视同不存在（跳过重放直进 flight，覆写台账行）；done 行重放前比对请求指纹，不符抛结构化 `IDEMPOTENCY_KEY_REUSE` 错误；`idempotencyState` 把 error 行报 `new`。验证：`scripts/test-wanxing-facade.mjs` 新增三断言（错误答重执行覆写 / 同键同体重放 / 同键异体 409）全绿。
- [x] 1.3
- [x] 1.4 遗留行收口：重放要求已绑定指纹——NULL 指纹行遇带指纹重试=重执行一次并回填绑定（双无指纹调用方保留纯重放）；验证：facade 测试新增「legacy 行首触自愈」断言 34/34。 a2a.js send 路径：计算 rpcBody 指纹传入 `idempotentSend`；`IDEMPOTENCY_KEY_REUSE` 分支返回 HTTP 409 结构化错误（与 TURN_IN_FLIGHT 同层同款，不走 JSON-RPC 200 包装）。验证：facade 测试补 409 状态码断言。

## 2. runner 冷启动残余（② agent-runner）

- [x] 2.1 child.js start()：initialize 烧尽/其他失败的 catch 里对局部 `client` 调 `close()` 再重抛（EOF→SIGTERM→SIGKILL 阶梯），杜绝孤儿 dsh。验证：`scripts/test-agent-runner.mjs` 新增「必败 initialize 后工厂 client 收到 close」断言（直构 AgentChild + 必败 clientFactory）。
- [x] 2.2 manager.js `#spawnChild` 失败升级：按 agentKey 记退避计数，spawn 失败整进程重试（2s/4s/8s，3 次），烧尽抛 `code: -32004` 结构化冷启动错误；成功 spawn 清零；下次消息照常再 spawn。验证：测试新增「必败工厂烧尽后抛 -32004 且不留 map 残项」「第二轮成功后计数清零」两断言。
- [x] 2.3 回归：`node scripts/test-agent-runner.mjs` 全量（43+ 新增）全绿。

## 3. runner 物化属主防线（① agent-runner）

- [x] 3.1 compose.js `materializeAgentHome` 属主守卫：stat home 根，外部属主时——root 进程 `chown -R`（spawnSync chown，不跟随符号链接）到 `AGENT_RUNNER_HOME_UID`（默认 1000）并留痕日志；非 root 抛结构化错误（指路径 + 修复指令）。验证：单测覆盖三分支（同属主直过 / root 修复 / 非 root 拒绝），非 linux 跳过守卫。
- [x] 3.2 docker-compose.yml：`user: "0:0"` → `user: "1000:1000"`，注释改写为 root 卷迁移指引（chown 一步 + 起新形状）。验证：compose config 解析通过；fleet 接入配方文档（docs/ 或 SKILL.md 所在处）同步一行。

## 4. 全链验证与部署

- [x] 4.1 本地全量回归：agent-runner 43+N、wanxing-facade/bookkeeping、既有 gateway 相关单测全绿；lint 过。
- [x] 4.2 部署：GHA→TCR 标准线出镜像；fd-prod 滚動（門面侧生效）；cheap-1 runner 容器随新镜像重建（uid 1000 形状不回退）。验证：`docker logs` 无新告警 + facade 探针（同键异体 409 / 错误答可重试）双绿。
- [x] 4.3 生产冒烟（真回合）：柏讯线任一 agent 同键同体重放返回旧答；人为触发一次错误后同键重试真执行；runner 冷启动正常。回执留档。
