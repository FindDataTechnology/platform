# fix-runner-port-collision — Design

## Context

事故链（台账 §15.33）：deploy 时 registry 列表抖动 → 占用图静默为空 → reception 与 daas-analyst 哈希同落 8809 → runner `server.listen` 无 error 处理 → unhandled 'error' 事件崩掉整个 runner 进程（16 个 agent 全下线）。两处都是防御缺失，不是逻辑错误——正常路径（列表成功 + 端口无碰撞）行为正确。

## Goals / Non-Goals

**Goals:** 绑定失败隔离到单 agent；退化可见；正常路径逐字节不变。

**Non-Goals:** 不做 runner 侧端口自愈漂移（监听换端口会造成注册 URL/registry nginx location 与实际监听不一致的错误路由，比不可达更危险）；不动 registry 侧再生成调度（挂账②的 registry 专项）；不改 planAgentPort 算法。

## Decisions

### D1：runner 侧 skip+warn+节流+自然重试，不做端口漂移

`#ensureListener` 挂 `server.on("error")`：EADDRINUSE（或其他 listen error）→ 从 listeners 表释放该 key、指名 warn（含 agent/端口/port_override 修复指引）、不抛。修复指引指向生产已验证的手法（registry entry metadata.port_override）。节流：per-key 记 lastWarnAt，5 分钟内不重复。重试不需要专门机制——reconcile 周期发现 `#listeners` 缺该 key 会再次走 `#ensureListener`（现行为），端口释放后自然恢复。

否决的替代：runner 侧 ring-probe 换端口——registry 里登记的 URL 指向原端口，nginx 位置也按注册端口生成，静默换口=请求路由到别的 agent（比不可达更糟）。

### D2：deploy 侧只加可见性，不改降级语义

占用图列表失败时保持纯哈希降级（registry 瞬断拒绝部署=可用性事故），但 catch 里 loud warn 指名「碰撞检测已退化」。防碰撞的主防线本来就该是 runner 韧性（D1），列表只是优化。

### D3：EADDRINUSE 判定用错误码而非消息文本

`err.code === "EADDRINUSE"` 精确判定；其他 listen 错误同样接住（warn+释放）但文案区分，避免误指端口冲突。

## Risks / Trade-offs

- [节流窗口内端口释放、恢复延迟 ≤5min warn 窗口] → 重试绑定不受节流影响（节流只压日志），恢复即时。
- [listen error 可能异步于 #ensureListener 返回] → error 处理里同步清理 listeners 表条目；`#stopListener` 的 close 对已失败 server 幂等无害。

## Migration Plan

随下一班 platform 镜像滚产（三面 + agent-runner-serving/b/c 同镜像）。回滚=回滚 tag；无数据/状态迁移。

## Open Questions

（无）
