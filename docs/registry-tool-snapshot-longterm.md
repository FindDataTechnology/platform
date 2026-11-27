# 长期方案：逐用户凭据服务的工具面快照不再依赖探针

> 来源：`wire-build-mcp` 加 2 个工具后发布被挡（2026-10-23）
> 对象：paas（registry fork + 发布门）／finddata（server 仓）
> 状态：**提案，待评审**。这是结构性问题，不是本次事故的补丁。

## 一、问题（一句话）

registry 的 `tool_list` 快照靠**探针**更新，而**逐用户凭据的服务**（Bearer 原样转发、匿名一律 401）永远探不到工具面——于是每次工具面变更都要人来点一次控制台。

## 二、证据链（本次实测）

```
新镜像上线      pod 17 工具，/health 200
registry 探针   POST /mcp → 401（pod 日志里每几秒一条，持续）
快照            tool_list 仍 15
发布门          判 2 个新工具 unresolved → 拒绝发布
人工刷新        POST /api/refresh/wire-build-mcp → 同样 401 → 快照不变
```

**不是时序问题，不是缓存问题**：探针被鉴权挡住，重试一万次结果相同。

## 三、影响面（为什么必须根治）

所有「进站 Bearer 原样转发」的服务都命中同一形态。当前在册至少：

| 服务 | 凭据形态 | 探针可达 |
|---|---|---|
| `wire-build-mcp` | 双轨（Logto ID token / `wdk_` key） | ✗ |
| `wire-ops-mcp` | 双轨 | ✗ |
| `wanxing-ops-mcp` | 平台令牌 / caller `sk-` | ✗ |
| `paper-trading` | 逐用户 `fdt_` | ✗（台账已记 `mcp_endpoint` 缺失伪红） |
| 其余只读服务 | 无 | ✓ |

**后果**：每加一个工具 = 一次人工刷新；而这次还叠加「刷新也失败」，只能手写 17 个名字。舰队化以后工具面会频繁变，这是必经之路。

## 四、候选方案

| # | 方案 | 改动面 | 漂移风险 | 评价 |
|---|---|---|---|---|
| **A** | **服务启动时自报工具面**（push） | 服务 + `/health` 邻近 | 极低（真源就是运行中的服务） | **推荐** |
| B | 条目存后端凭据，探针用它认证 | registry fork | 低 | 需要造一套服务凭据管理，且逐用户服务的"服务级凭据"是新增概念 |
| C | 无鉴权 `/tools` 端点（只列名字） | 服务 | 低 | 最小改动，但公开能力面；对逐用户服务是边界松动 |
| D | 部署清单里静态声明 `tool_list` | GitOps + registry | 中（声明与实现可漂） | 有 `tool-surface.json` + CI selfcheck 兜底，实际漂移风险不高 |
| E | 维持人工刷新 | 无 | — | 现状，不可持续 |

## 五、推荐方案 A：服务启动自报

### 契约

服务在**启动成功、工具注册完成后**，向 registry 的**内部接口**提交自己的工具名清单：

```
POST {REGISTRY_INTERNAL_URL}/api/internal/servers/{path}/tool-list
Authorization: Bearer {REGISTRY_REPORT_TOKEN}     # 平台内部服务凭据
{ "tools": ["...", ...], "surface_version": "<tool-surface.json sha>" }
```

- 只在**启动时**报一次（幂等覆盖），不做周期心跳——工具面只在进程重启时变化；
- 失败**不阻塞启动**（registry 不可达时服务照常提供能力），但要在 `/health` 里暴露 `last_surface_report: ok|failed:<reason>`；
- registry 侧：新增内部路由（不走控制台会话），校验服务凭据，写 `tool_list` + `num_tools`；
- 提供人工兜底：现有 `POST /api/refresh/<path>` 与 `--from-json` 保留不动。

### 为什么是 push 不是 pull

| | push（A） | pull（B/C） |
|---|---|---|
| 真源 | 运行中的进程自己 | 探针的视角 |
| 逐用户凭据 | 无影响（内部凭据是平台侧的） | 要么加服务凭据，要么开匿名口 |
| 时效 | 启动即生效 | 等下次轮询 |
| 失败可见 | 服务自己知道并上报 | registry 只能猜 |

### 为什么不用 `tool-surface.json` 直接给 registry 读

工具面真源是**代码里注册的工具**，`tool-surface.json` 是它的**构建期镜像**。两者已经由 `selfcheck_surface.py` 双向断言（manifest ↔ runtime），所以自报时用**运行时枚举**、并把 `surface_version` 一并带上——既能被 registry 用，也能让人核对是哪一版。

## 六、实施拆解

```
① registry 内部路由          paas：/api/internal/servers/{path}/tool-list（内部凭据）
② 服务侧启动自报             finddata：wire-build-mcp 先做，抽成共用模块给五线 ops-mcp
③ 健康面暴露上报态           /health 增 last_surface_report 字段
④ 回填存量                   wanxing-ops / wire-ops / paper-trading 三个逐用户服务
⑤ 台账与发布门文档更新       MCP-REGISTRY.md、registry-maintenance.md §6
```

①②是硬依赖，③④⑤可分批。

## 七、验收

1. 改一个服务的工具面 → 出片滚版 → **不做任何人工动作** → registry `tool_list` 等于运行时真值；
2. 发布门对新增工具不再报 unresolved；
3. registry 不可达时服务仍能起来，`/health` 显示上报失败原因；
4. 未接入自报的既有服务行为逐字节不变（不强制迁移）。

## 八、与本次事故的关系

本次 `柏讯 · 产物构建` 的解锁仍走人工直写（17 个名字已备好）。**但那是最后一次**——方案 A 落地后，同类更新不再需要人。

## 九、明确不做

- 不做周期心跳上报（工具面不随运行变化，白烧）；
- 不把逐用户服务改成匿名可探（那是边界松动，换来的只是省一次推送）；
- 不让 registry 自己解析源码仓的 `tool-surface.json`（跨仓耦合，且构建镜像≠运行实例）。
