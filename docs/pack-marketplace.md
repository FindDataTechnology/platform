# 功能集市场（Pack Marketplace）运维手册

功能集（pack）= 内联技能内容 + registry MCP 引用 + persona 角色的版本化清单，发布到部署级的 pack registry，其他用户在「设置 → 功能集」浏览、检查、一键订阅。设计决策见 OpenSpec change `add-pack-marketplace`（design.md D1–D15，已归档）。

## 1. 架构速览

市场面（browse/publish/subscribe）由 `gateway/packs.js` 的 `registerPackRoutes` 提供，两种部署拓扑各自挂载：

```
多 cell 云拓扑:  浏览器 ──> gateway (/api/packs…)  市场（gateway SQLite: packs.db）
                         └──> cell (/api/mypacks…) 本地：草稿 + 已装 + 物化
单进程（fd-prod）: 浏览器 ──> server.js 同进程挂两个面（同一模块 verbatim 复用，
                                gateway/mp-auth.js 先例）——市场库在部署数据根
                                data/packs.db，与用户 SQLite（app.db）分文件
```

- 发布门控：平台 groups 含 `creators`（Logto 组织，与 `legal`/`analysts` 同机制）。
- 版本不可变：发布即追加 vN+1；下架 = unlisted（浏览隐藏，已装快照不受影响）。
- 订阅 = 安装当前版本快照 + 订阅记录；新版仅显示更新徽标，手动升级。
- 安全边界（v1）：MCP 条目只能引用 registry 已注册 server；角色条目 persona-only（无 baseUrl/model/凭据）；skill 内容内联。

## 2. 开通步骤（fd-prod，单进程拓扑）

### 2.1 Logto 组织 `creators`

Logto 管理台 → Organizations → 新建 `creators` → 把可发布用户加入组织。平台 groups 会带上该组织 ID；`PACK_CREATOR_GROUPS` 可同时列可读名与组织 ID（逗号分隔，命中其一即可）。

### 2.2 环境变量（platform-config ConfigMap）

```yaml
PACK_MARKETPLACE: "1"           # 总开关：注册市场路由 + 显示功能集 UI
PACK_CREATOR_GROUPS: "creators" # 可选；默认 creators，可加组织 ID
PACK_BASELINE_MCP: "websearch"  # 可选；聚焦模式仍加载的基线 MCP（逗号/空格分隔）
```

改 ConfigMap 后需 rollout 生效；ArgoCD 有 ~3min 轮询滞后，先 annotate refresh 再等 rollout（运维手册）。**本地/dev 部署不加 `PACK_MARKETPLACE`**——功能集入口整体隐藏。

`PACK_BASELINE_MCP`（pack-agent-scoping）：选中功能集角色时运行时进入聚焦模式——只装载基线 + 该包资源集。基线 = mcp.json 全部 server ∪ 此变量列出的 server 名（未安装的名字告警跳过，不阻断启动）。fd-prod 建议列出 `websearch` 这类注册市场装的全局可用服务；不配置时基线即 mcp.json 本身。量化对比用 `node scripts/probe-pack-scope.mjs`（见 openspec changes/add-pack-agent-scoping/measurements.md）。

### 2.3 重新发布四个 vertical packs（种子内容）

内容源：`docs/vertical-packs/skills/`（技能正文）+ `docs/vertical-packs.md` §1 组装表（MCP 引用、角色）。用一个 creators 组成员的浏览器会话：

1. 登录 fd-prod → 设置 → 功能集 → 我的创作 → 新建功能集。
2. 名称/描述/标签按 §1（如 法律-合同 / 合同审查工作流 / [法律, 合同]）。
3. 技能：粘贴 `legal-contract-workflow` 的 SKILL.md 正文（frontmatter 的 name/description 填进表单对应字段，只贴正文）。
4. MCP：从选取器勾选 `law-bench`（法律-合同/案件）或 `fd-open-data-mcp` + `fd-cn-report`（数据包）。
5. 角色：id `pack-contract-reviewer` 等、persona 取原 agents.json 条目的 persona 或由 name/description 生成。
6. 发布 → 记下 pack id（详情页/市场卡片）。发新版本 = 编辑同一草稿再发布。

> 注意与旧机制的关系：`registry-groups.json` 仍管「registry 条目在市场里对谁可见」；pack 订阅时的 MCP 安装沿用同一门控（无组 → 报告里标注不可用，不阻塞其余部分）。`AGENTS_CONFIG_URL` 云端目录条目照旧优先于 pack 角色（目录合并序 built-in → registry → packs → agents.json → cloud）。

## 3. 验证清单

- creators 成员：设置里出现「功能集」；能新建草稿并发布（v1）。
- 非 creators 登录用户：能浏览/订阅；「我的创作」页可用但发布按钮报 403（编辑器内显示错误）。
- 订阅后：技能出现在 设置→技能（数据库源）；MCP 出现在 设置→MCP（registry 凭据未连接时报告标注，连接后重订阅或直接装 MCP）；角色出现在对话的 agent 选择器（本地 persona，切换有 5–10 秒重启）。
- 作者发新版：订阅者「我的功能集」出现更新徽标，点击升级后版本号变化。
- 退订：技能/角色消失，MCP 配置保留。

## 4. 回滚

- UI 层面：去掉 cell 的 `PACK_MARKETPLACE` 即隐藏全部入口（无数据迁移）。
- gateway：`packs.db` 独立文件，可单独删除/备份；订阅者 cell 的已装快照不受 gateway 数据影响。
- cell 侧表（`pack_drafts` / `installed_packs` / `custom_skills` 新列）均为增量，留置无害。

## 5. 已知边界（v1）

- 作者不能自带 MCP 端点（v2 议题：registry 注册权开放给 creators）。
- 更新无推送：徽标在打开「我的功能集」时拉取比较（design D13）。
- 滥用举报/下架工具未建：作者可自行 unpublish；admin 可直连 gateway SQLite 处理（备份后操作）。
