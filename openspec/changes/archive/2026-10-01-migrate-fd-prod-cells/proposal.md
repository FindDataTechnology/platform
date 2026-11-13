# Proposal: migrate-fd-prod-cells

## Why

fd-prod 的 platform 以单进程运行：documents / resources / `/api/files` 三个服务根全部没有按用户隔离（任何登录账号可读可删任意条目），且**一个 dsh agent 服务所有用户的对话**——workspace、上下文、cron 都在租户间共享。今天它只靠「只有一个账号在用」的约定维持安全。架构早已选定多租户答案（gateway + per-user cells，`tenant-cell-runtime` 规格），代码与 e2e 均已落地，但**没有任何生产实例在跑它**；迁移是把已验证的拓扑接到真实流量上。

## What Changes

- **fd-prod 换入口**：platform Deployment 的启动命令改为 `node gateway/index.js`，Logto 与 MP（bind-code / login-account）认证收口到网关；对外 origin 不变（craw ingress 原样，Logto 回调 URI 不用改）。
- **per-cell workspace（同时是 bug 修复）**：spawner 给每个 cell 设 `AGENT_WORKSPACE=<CELL_DATA_ROOT>/<userId>/workspace` 并预建目录。既堵住「cell workspace 兜底到共享 REPO」的隐性跨用户泄漏，也修复 demo cell 里 agent 产出文件不可下载、不可入库的缺陷。
- **一次性存量数据迁移**：单进程时代的 `/data`（SQLite 会话/文档/资源库、uploads、cron）与 `/data/workspace` 迁入 owner 账号（1257774197@qq.com）的 cell 数据根，归属即数据Owner。
- **a2a 服务车道**：registry 反代过来的 Agent Service 流量（无用户会话、仅部署凭据）由网关按「服务 → 所属 cell」路由，服务随部署它的用户走。
- **容量包络**：按实测定资源预算（网关空载 ~230Mi、活跃 cell ≈ 300–400Mi、节点 8C/8Gi），配 idle reap，Pod 限额建议 2Gi 起步。
- **BREAKING**：切换时刻已登录的浏览器会话失效（网关签新 cookie，需重新登录一次）；单进程时代的环境变量布局变化（`platform-config` 里的 `AGENT_WORKSPACE` 保留作回滚保险，网关路径下被 spawner 的 per-cell 值权威覆盖）。

## Capabilities

### New Capabilities

（无——全部落在既有能力上。）

### Modified Capabilities

- `tenant-cell-runtime`: 隔离清单显式纳入 agent workspace 与资源库/上传服务根；新增「每个 cell 启动即持有 per-user 可写 workspace（经既有 AGENT_WORKSPACE boot 链校验，兜底不得落在跨 cell 共享目录）」与「网关按 owner 路由无会话的服务车道（registry 反代的 a2a 流量）」两条需求。

## Impact

- **代码**：`gateway/spawner.js`（cell env + 目录预建）、`gateway/index.js`（a2a lane 路由表）、`registry-bridge.js`（注册 URL 推导携带 cell 归属）。
- **部署**：fd-infra-deploy GitOps（platform Deployment command/env 重排、platform-config 清理）、DEPLOY.md 新增多租户运行手册。
- **周边**：ops-console 对 platform 的探活口径核对；MP 客户端零改动（网关本来就是 MP 的设计入口）；session-share 由网关托管（现状已如此）。
- **不变**：单进程模式（dev / 桌面 / demo pod）行为完全保留（既有 requirement）；对外域名与 API 路径不变。
