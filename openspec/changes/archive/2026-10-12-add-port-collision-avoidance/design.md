# Design: add-port-collision-avoidance

## 核心不变式

部署侧注册的 URL 端口 === runner 绑定的监听端口，二者由**同一份数据**推出：
`port = valid(metadata.port_override) ? override : agentPortFor(path, {base, span})`。
`resolveAgentPort` 单一定义放 lib/agent-serving.js，双端共用。

## 部署侧（deployToRegistry）

1. 尽力列出注册处既有条目（失败=放弃检测，行为回退纯哈希——不因注册处抖动断部署）。
2. 切片分组：`entrySlice(e) = e.metadata?.runner_id ?? null`；与本部署的有效切片
   （`runnerId ?? null`）相同者进入占用集，各算 `resolveAgentPort`；**本包正在部署的
   agent 逐个入占**（同包互撞也防）。
3. 候选=哈希位；被占→向上环形探测 span 内首个空位；全部占满→400「段耗尽」。
4. 改判发生（或既有条目已带合法 override）→ descriptor 写 `port_override`，URL 用
   同一端口。已带 override 的重部署**保持原值**（不漂移不迁移）。

## runner 侧

`#ensureListener` 与 `health()` 改用共享 `resolveAgentPort`：合法（整数且在
`[base, base+span)`）才用，否则哈希。listener 生命周期不变。

## 不做

- 不改 span（改=存量全部 URL 断）；不做 runner 回写（单写者纪律）；不做自动再平衡
  （override 稳定即可，空洞留给未来调度）。
