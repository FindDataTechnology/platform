## Why

记忆面（切片 2）与统计面（切片 3）已上产，但记忆服务今天只服务萬星部署 agent（d/ namespace）——壹座 cell 里的 dsh agent 与本地开发机的 harness 会话仍是无记忆孤岛。切片 4 前置 spike 已实证联邦路径（fd-memory `docs/spike-hook-wire.md`）：ai-memory 的 hooks 投递线上协议是 `POST /hook?event&agent&cwd&ingest_key` + spool-then-drain，fd-memory 实现该端点即可让本地 stock 节点零改动接入；切片 1 已证 agent 侧 MCP 查询跨端可用。「通用=格式+协议」的论题在此兑现：同一舰队记忆服务三类消费者（萬星部署、壹座 cell、本地节点）。

## What Changes

- **fd-memory `/hook` 兼容端点**：按 spike 实测协议接收投递（query 解包 event/agent/cwd/ingest_key + body=hook payload 原文 + Bearer 人令牌）→ 映射 capture 事件落 `u/<owner>/p/<cwd basename>` namespace；`ingest_key+session_id+event+ts` 幂等去重（spool 重投不双计）。
- **fd-memory 平台服务令牌**：新增 `platform` scope（paas 后端专用）——可为其用户代铸 person 令牌（u/ 绑定），capture 与 MCP 皆拒（纯铸造面）；`/admin/mint` 扩展接受 platform 令牌铸 person 族。
- **fd-memory NodePort 暴露**：`fd-memory` service 增 NodePort（tailnet 可达），本地节点经 `ai-memory server add fleet` 直投；公网面不做（产品化阶段再议）。
- **壹座 cell 记忆挂载（v1）**：cell 的 dsh 组合注入 fd-memory MCP 行（`mcp__fd-memory__*` 工具进 cell 会话），namespace=`u/<owner>/p/cell`（v1 单项目，per-project 拆分后续）；人令牌由 cell 后端经 platform 令牌按 owner 首触代铸并缓存，经既有凭据引用纪律注入（值不落明文配置）。
- **本地联邦套件**：接入配方文档（server add + `.ai-memory.toml` + 定时 `ai-memory recover` launchd 样例）+ 本机首批接入实测。
- **非目标**：不实现 stock 冷导入（7.2B 降级为可选迁移工具，spike 附录在案）；不做团队共享 namespace；不做公网暴露与 Logto 自助铸币；不动萬星侧（切片 2 已覆盖）。

## Capabilities

### New Capabilities

- `memory-federation`: 联邦契约——/hook 兼容端点的线上形状与幂等、platform 令牌铸造面、cell 挂载的 namespace/令牌纪律、本地节点接入配方。

### Modified Capabilities

- `fleet-memory`: 新增要求——人令牌经 /hook 写入其 u/ namespace（与 MCP 面同 scope）；platform 族令牌的权限边界。

## Impact

- **fd-memory**（~/finddata/fd-memory）：/hook 端点、platform scope、NodePort、幂等表。
- **paas**：cell 侧 dsh 组合注入（dsh-profile/mcp 组合路径）+ platform 令牌经部署 secret + 人令牌代铸客户端；壹座设置不动（无新分节，v1 静默挂载）。
- **部署**：fd-memory 滚一次镜像 + NodePort；paas 平台镜像滚一次。
- **验收基线**：①本机 stock ai-memory 实投回合事件落 u/ namespace（recover 排空后可检索）②壹座 cell 真机会话见 `mcp__fd-memory__*` 工具且 handoff 写入落库 ③跨三消费者的同 namespace 读写互见（cell 写→本地查）④令牌边界：platform 令牌不能读写数据面。
