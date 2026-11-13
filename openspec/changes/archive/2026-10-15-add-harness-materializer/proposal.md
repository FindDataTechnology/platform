## Why

切片③（add-harness-adapter）让 runner 能以 `harness: acp-claude-code` 部署 agent，但组合层仍是 dsh 专用：`#spawnChild` 对**任何** harness 都跑 `materializeAgentHome`——为 ACP 部署物化一份**没人读的 DSH_HOME**（seed 拷贝、preset/skills/MCP patch、LLM profile 全部白做），而 claude-code-acp 实际拿到的只有 `{cwd, env, model}`：**persona、skills、MCP 引用、数据工作区全部落空**，部署门放行的 pack 内容在非 dsh harness 上一文不值。谦面 CLI 侧的多 target 物化（claude-code/cursor/zcode/codex/gemini-cli 五端）已是成品——本变更补上 serving 面的另一半，让「pack 清单 → 各 harness 布局」在 runner 上成立（萬星多 harness 线切片④）。

## What Changes

- **harness 感知的组合分派**：manager 按 `harnessRegistry.kindOf(harness)` 分派物化——`dsh` 走既有 `materializeAgentHome`/`materializePackHome` **字节级零变化**；ACP 类 harness 走新的工作区物化器，不再 seed/patch DSH_HOME。
- **`materializeAcpWorkspace`（新）**：为 ACP 部署物化 harness 原生工作区——persona → 工作区 `CLAUDE.md`（含 serving 后缀，与 dsh preset persona 同文）；skills → `.claude/skills/<name>/SKILL.md`（近恒等拷贝，与谦面 CLI 同布局约定）；workspace 声明 → 工作区内 `data/` + `AGENT_DATA_DIR`/quota env（既有 `workspaceChildEnv` 不变复用）。
- **MCP 上 ACP 线**：adapter 的 `session/new` 从写死 `mcpServers: []` 改为透传 spawnSpec 携带的 ACP 形状数组（registry 名 → `{name, url, headers}` streamable-http 行，token 解析与 dsh 侧 `mcpEntry` 同源同纪律）。
- **凭据通道按 harness 如实分派**：billing key → ACP 子进程 env 覆写（同一网关基址，语义= dsh 侧 `applyBillingKey` 的等价物）；**声明 deployment secrets 的 ACP 部署组合期结构化拒绝**（env 对任意 ACP 二进制不是受控通道，fail-closed 而非静默丢失——今天的行为是写进没人读的文件=静默丢）；`mcpTools` 工具面 → 降级开放 + warn（无 ACP 等价物，能力表哲学）。
- **布局映射按 harness 名注册**：v1 只实现 `acp-claude-code` 布局；其他 ACP 名（未来 gemini-cli 等）→ 裸工作区（cwd/env/model）+ 显式 warn，不静默假装。

## Capabilities

### New Capabilities

（无——本变更是既有 harness-adapter 能力面的收拢，不新开能力。）

### Modified Capabilities

- `harness-adapter`: 新增一条要求——pack 内容（persona/skills/MCP/workspace/凭据）SHALL 物化进目标 harness 的原生布局；dsh 路径零变化；无法如实物化的部分 SHALL 结构化拒绝或如实降级，永不静默丢失。附场景：ACP 部署的工作区布局（CLAUDE.md+skills 落盘）、MCP 随 session/new 传递、secrets fail-closed、未知 ACP harness 裸降级。

## Impact

- **代码**：`agent-runner/compose.js`（不动，dsh 专用保持）；新 `agent-runner/compose-acp.js`（工作区物化器 + 布局表）；`agent-runner/harness/acp.js`（session/new 透传 mcpServers）；`agent-runner/harness/registry.js`（spawnSpec 增补 ACP mcpServers 形状）；`agent-runner/manager.js`（`#spawnChild` 按 harness kind 分派 + billing env 覆写 + secrets 拒绝 + 跳过 DSH_HOME）。
- **镜像/出片**：runner 镜像重出（布局无新依赖，纯 JS）；`AGENT_RUNNER_ACP_COMMANDS`/心跳/部署门零变化（harness 集不变）。
- **测试**：新单测（物化器布局/幂等/拒绝路径）+ test-harness-adapter 增 mcpServers 透传合同（fake agent 回显）+ 生产 in-pod E2E（真 claude-code-acp：persona 影响答复、skill 落盘、MCP 会话面接受）。
- **不碰**：谦面 CLI（`facet/cli`）五 target 本地安装已是成品；`pack-installation` spec 管辖的 cell 侧安装；dsh 侧物化与 pod 共宿。
