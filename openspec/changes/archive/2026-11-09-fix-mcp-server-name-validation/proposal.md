# 注入的连接器行必须过 dsh 的 serverName 校验

## Why

真机演练（2026-11-09，镜像 `sha-d37c9fd`）打到了最后一环：岗位的 home 里 `mcp.patch.yml` 有行、
`.credentials.yaml` 有令牌、插件包也在，但岗位在回合里明确回答**没有任何 `mcp__connector__*` 工具**。

根因是命名不合 `@deepseek-ai/dsh-mcp-client` 的约束：`lib/index.js` 用
`SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/` 校验 `serverName`，而我们生成的是
`connector:<packId>:<bindingKey>`（含冒号、常见 38 字符）。校验失败后因为插入行带
`failOnStartupError: false`，**server 静默不启动**——磁盘上一切正常，工具面里什么都没有。
同一条规则也打在交互面的 `connector:chat:explore` 上。

## What Changes

- 绑定行的 serverName 改为 `connector_<slug>_<hash8>`：合法字符集、≤32 字符、slug 可读、
  hash 保证不同 slot 不撞名。
- slot 不再从名字里切（名字有损且不可逆），改由「同一份定义」反查：401 处理器按 owner 的
  `injectionRows` 名字匹配回 slot。
- runner 侧对任何外来名字做防御性收紧（descriptor 也可能给出不合规的名字）。

## Impact

- 能力：`connector-bindings`（注入行的命名约束）
- 代码：`connector-bindings.js`、`gateway/packs.js`（descriptor 的 serverName）、
  `server/dsh-events.js`（401 → slot 解析）、`agent-runner/compose.js`（`compliantServerName`）
- 不改变授权语义、不改变令牌、不改变存储
