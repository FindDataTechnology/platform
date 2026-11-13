# Proposal: harden-windows-runner-smoke (paas)

## Why

壹座桌面版在 windows-admin 实测（2026-11-06）跑通全链后，沉淀出三个产品级缺陷：①profile 模板 `package.json` 缺 `version`，任何不骑部署树符号链接的新物化 home 都会让 inventory 扩展抛「non-empty name and version」（cause 被链吞，定位成本极高，本次靠给装机器打透传补丁才挖出）；②`agent-runner` 的 RSS 采样在 Windows 每 poll 调不存在的 `ps`，刷错误日志；③`win-install-smoke` CI 只验 server.js（Phase B），runner 子进程腿零覆盖——当晚整类 Windows runner 缺陷全部漏网。

## What Changes

- `dsh-profile-template/package.json` 补 `"version"` 字段——inventory 的 `identityFromManifest` 要求非空 name+version，模板是所有新物化 profile 的根。
- `agent-runner/manager.js` `sampleRssBytes`：win32 短路返回 null（与 compose.js uid 纪律同法），消灭每 poll 的 ps 错误噪声。
- `win-install-smoke.yml` 新增 **Phase B+（runner leg）**：打包环境起 agent-runner → 用 manifest body 装 minimal pack → 本地 feed 部署 → 断言 dsh 子进程**存活 ≥30s**（精确覆盖 0xc0000142 类「子进程秒死」回归；不需要 LLM 键）。

## Capabilities (scope)

- Modified capability: `agent-runner`（RSS 采样 Windows 短路）
- Modified capability: `desktop-catch-up-release` / win-smoke（Phase B+ runner 腿）
- Out of scope: vendor `@deepseek-ai/dsh-llm-deepseek` 的 cause 吞错（上游件，装机器已打临时透传补丁，挂上游 issue）；0xc0000142 根因（ssh/nohup 环境链，非产品代码）。
