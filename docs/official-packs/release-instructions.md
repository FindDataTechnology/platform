# 官方功能集发布指南（add-line-boards-and-action-gate）

## 目标

发布两个 read-only 助手 pack，用于壹座中的谦面和萬星操作：
1. **谦面助手** (`facet-assistant`) — 只读 facet-market-mcp + facet-ops-mcp
2. **萬星机群助手** (`wanxing-fleet-assistant`) — 只读 wanxing-ops-mcp

## 前置条件

- 当前用户已在 `creators` 组（Logto 组织）
- 已安装 `facet-cli` CLI 工具
- 有访问谦面市场的凭据（设备配对）

## 发布步骤

### 1. 验证 manifest

```bash
cd docs/official-packs

# 谦面助手
facet validate facet-assistant-manifest.json

# 萬星机群助手
facet validate wanxing-fleet-assistant-manifest.json
```

确保所有工具名在注册处存在，且 allowTools 格式正确。

### 2. 发布到谦面市场

```bash
# 谦面助手
facet publish facet-assistant-manifest.json \
  --from https://facet.finddatatech.cloud \
  --new-name "谦面助手"

# 萬星机群助手
facet publish wanxing-fleet-assistant-manifest.json \
  --from https://facet.finddatatech.cloud \
  --new-name "萬星机群助手"
```

CLI 会打开设备配对页，粘贴 6 位码完成绑定。

### 3. 验证安装

在壹座中：
1. 进入「设置 → 连接」→ 确认「谦面市场」已连接
2. 进入「设置 → 功能集」→ 「我的创作」或「市场」标签
3. 找到新发布的两个包，点击「安装」装进 cell

### 4. 验收测试

#### 谦面助手
- 对话：「帮我搜索法律相关的包」
- 预期：助手调用 `facet_market_pack_browse(category="legal")` 返回结果
- 尝试写操作：「帮我发布一个新包」
- 预期：助手生成 propose_action 提议，展示影响面和风险等级

#### 萬星机群助手
- 对话：「列出所有 agent」
- 预期：助手调用 `wanxing_agents_browse()` 返回结果
- 尝试写操作：「部署一个 agent」
- 预期：助手生成 propose_action 提议，提示云端需要 billingKey、桌面需要机位在线

## 实际发布记录（2026-10-20）

未走 CLI 设备配对——用的是 **cell 里已连接的 facet-market 设备凭据直调市场 MCP**：
`facet_market_pack_validate`（干跑）→ `facet_market_pack_publish`。两包均已上架：
- 谦面助手：`qCEIutJzQd49jnDtV4qeqw` v1 public（作者 aloadtree@gmail.com）
- 萬星机群助手：`INdsRWpgpp2Q03I0z3XoFA` v1 public（同上）

前提：发布身份的 cell 已有 facet-market 凭据（aloadtree 早已配对）且在 creators 组。
发版 = 同 manifest 再调 publish（版本自动 +1）。无凭据的新身份仍需设置页一次配对。

前置注意：发布门会查 registry 快照——`wanxing-ops-mcp` 的 `tool_list` 曾为空导致
萬星包卡门，已 Mongo 直写回填 7 条（见 docs/registry-maintenance.md §tool_list 直写回填）。

## 回滚

如需下架：
```bash
facet publish <pack-id> --visibility unlisted
```

## 后续迭代

v1 是 read-only 版本。未来可逐步添加：
- 更多引导技能（如部署向导、故障排查）
- 与动作闸的深度集成（自动填充 preflight 参数）
- 多语言支持（当前仅中文）

---

**注意**：这两个 pack 的 publish lint 必须通过「不声明写工具」的检查。任何包含 write 工具的提交都会被拒绝。

## 柏讯助手发布记录（2026-10-21，add-wire-line-board 6.3）

同配方直调 facet-market-mcp（网关剥 Authorization → **走 NodePort 直连**
`http://cheap6.mesh.finddata.cn:31893/mcp`），发布身份 aloadtree 设备凭据：

- **柏讯助手：`ALuUIiL23WP5OqLIgSRX1g` v1 private**（作者 aloadtree@gmail.com）
- validate 干跑 `valid:true`（发布门过）——**前置**：registry 两条目 tool_list 回填
  （wire-ops-mcp 10 / wire-build-mcp 15，对象数组 Mongo 直写，见 registry-maintenance 台账），
  否则 allowTools 全部 unresolvable 卡门（與萬星同款）。
- 读面 = ops 7 + build 4（含 corrections_list）；`requiredGroup: wire-customers` 两条目。
- 验收 cell（platform-demo）真安装链 200：skills/mcpServers/agents 全 installed；
  propose_action stdio 握手 `["propose_action"]`。
- 转-public 前置：wire 客户身份的一次读回合实测（待 Logto 凭据，见 acceptance-criteria 待补）。

## v2：agent id 去撞（copilot-dock-focused-preset D6，2026-10-22）

**为什么要发 v2**：catalog 里 pack agent 的 id 就是 manifest 的 `agents[].id`（`catalog.js:209`，不带 pack 前缀）；
三个官方助手 v1 全叫 `assistant`，同一 cell 装两个以上时只有先装的那个 agent 会 materialize，
其余在安装报告里是 `skipped`、不进 catalog——副驾 dock 的按线解析（`GET /api/boards/:line/copilot`）
对这些线就拿不到聚焦助手，只能诚实降级为「未聚焦」。

**manifest 改动（已入仓）**：`agents[0].id` 分别改为 `facet-assistant` / `wanxing-fleet-assistant` / `wire-assistant`；
persona、工具白名单、技能都不动。仓库测试 `scripts/test-official-packs-lint.mjs` 钉死三者互异且不为 `assistant`。

**发布配方**：与 2026-10-20 记录相同——cell 内已连接的 facet-market 设备凭据直调市场 MCP
（网关剥 Authorization → 走 NodePort 直连 `http://cheap6.mesh.finddata.cn:31893/mcp`），
`facet_market_pack_validate`（干跑）→ `facet_market_pack_publish`（同 pack id，版本自动 +1）：
- 谦面助手 `qCEIutJzQd49jnDtV4qeqw` → v2
- 萬星机群助手 `INdsRWpgpp2Q03I0z3XoFA` → v2
- 柏讯助手 `ALuUIiL23WP5OqLIgSRX1g` → v2（仍 private）

**验收**：验收 cell 把已装的三包升级到 v2 后，`GET /api/boards/{facet,wanxing,wire}/copilot` 三线各自非 `null`，
`agentId` 分别为上面三个 id；`/boards/facet` 开副驾 → 上下文条「聚焦预设：谦面助手」。

**升级副作用**：已装 v1 的 cell 升级后 catalog id 变化；若 `agent.preset` 停在旧的 `assistant`，
`resolvePersona` 的自愈逻辑会回落为完整模式并打一行 warn——与任何 pack 升级相同，不需要手工清理。

**发布记录（待填）**：
