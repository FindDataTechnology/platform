# Tasks: simplify-ia-non-technical

## 1. i18n 命名表落地（五语言）

- [x] 1.1 zh-CN 定稿新值与新键：nav 五名（对话/资料库/成果/智能体/自动化）、设置三组名与分节名（技能与工具/渠道接入/诊断）、智能体页三 tab 名（专家/行业方案/应用）、页面标题（资料库/成果/自动化）、去术语化说明文案；`npm run check:locales` 通过
- [x] 1.2 en/es/fr/ja 四语言同步新值（en: Materials/Outputs/Automation/Channels/Diagnostics/Industry Packs），`check:locales` 五语言全绿

## 2. 导航收敛 7→5

- [x] 2.1 `Sidebar.tsx` NAV_BASE 移除 bots/trace 两项；验证五 tab 渲染顺序 Chat/Knowledge/Resources/Agents/Tasks、zh 标签为 对话/资料库/成果/智能体/自动化、`nav-*` testid 保留
- [x] 2.2 用户可见文案去术语清扫：任务页 cron 措辞、扩展页 "MCP" 标题改「工具（外部连接，MCP）」式括注；抽查 grep 确认五套用户面文案无裸 MCP/cron/Base URL

## 3. 设置注册表重组（三组 + 分节迁移）

- [x] 3.1 `sections.ts` 加 `group` 字段（basics/capabilities/management）并按 design D4 归组；`SettingsDialog` 分组标题渲染；验证现有分节 slug/testid 不变、懒加载不回退
- [x] 3.2 合并「技能与工具」双 slug：`mcp`/`skills` 都解析到同一分节并各预选子视图；验证 `/settings/mcp`、`/settings/skills`、旧 `/mcp`/`/skills`/`/extensions*` 重定向全解析
- [x] 3.3 注册表删除 presets/packs 分节、新增 channels（挂 BotsPage）与 diagnostics（挂 TracePage 列表）分节；`App.tsx` 加重定向 `/bots→/settings/channels`、`/trace→/settings/diagnostics`、`/settings/presets→/agents?tab=agents`、`/settings/packs→/agents?tab=market`；验证 `/trace/:turnId` 仍为顶级整页路由
- [x] 3.4 Models 分节非 admin 只读视图：admin/开放部署渲染原管理面，非 admin 渲染名册（provider+roster+已知 serving 状态）且无管理控件；以铸造非 admin 身份实测两种渲染

## 4. 智能体页三 tab 统一

- [x] 4.1 `/agents` 改三 tab（agents=专家/market=行业方案/apps=应用），`?tab=` 深链与默认回落（无参→专家；无市场部署 market tab 不渲染且回落）；验证旧 `?tab=agents|apps` 深链不变
- [x] 4.2 专家 tab：catalog 列表（已含 customPreset 条目）+ 行内 编辑/删除/转草稿 按钮 + 页头「新建专家」，编辑器复用 CustomPresetsPage 表单组件（含 streamBusy 保护）；验证新建→保存→`catalog_changed` 刷新链 + picker 同步可见
- [x] 4.3 行业方案 tab：PacksPage 整体挂入、`requiresPackMarketplace` 门随迁；验证市场部署三内页（市场/我的/草稿）可用、无市场部署 tab 缺席

## 5. e2e 迁移与回归

- [x] 5.1 grep 清单清扫：nav-bots/nav-trace、settings-section-presets/packs、`?tab=agents` 两 tab 断言、/bots /trace 整页断言的用例全部改写到新面；本地 `npm run lint && npm run build` 绿
- [x] 5.2 新增/迁移重定向与入口用例（五组重定向、channels/diagnostics 分节、专家 tab 管理面、market 门控）；CI e2e 全绿（e2e 走 GitHub CI，看步骤级结论）

## 6. 上线

- [x] 6.1 标准发布线（源码 push→CI 绿→镜像→GitOps tag→ArgoCD 滚动），上线后冒烟：五 tab、三组设置、三 tab 智能体页、五组重定向、模型只读视图（生产非 admin 账号）
