# Proposal: simplify-ia-non-technical

## Why

壹座托管面服务的核心对象是没有技术能力的文本/数据处理人员，但当前信息架构带着开发者基因：「智能体 / 自建预设 / 功能集 / 应用」四个概念描述同一件事（挑一个懂行的角色干活），「知识库 / 资源」不表达进/出方向感，「机器人 / 调用追踪」两个运维面占着一级导航，「MCP 服务器 / Base URL / API 密钥 / 绝对路径」散落在用户必经之路上。统一语言是教程、市场与增长的前置条件——先用 R1 把词说对、把结构收拢。

## What Changes

- **导航 7 → 5**：侧边栏收敛为 对话 / 资料库 / 成果 / 智能体 / 自动化。「机器人」「调用追踪」从一级导航移除（路由保留，见下）。仅改 locale 显示名与分节归属，**路由 slug、testid、tab 顺序结构原则全部不动**（slug 是公开 API）。
- **命名表落地（zh-CN 主导，五语言同步）**：聊天→对话、知识库→资料库、资源→成果、任务/任务中心→自动化、MCP 服务器→工具（「技能与工具」）、功能集→行业方案、自建预设→我的专家。用户可见文案不再出现 MCP / cron / Base URL 词汇（高级场景在节内说明中保留一次术语解释）。
- **智能体页统一四概念**：`/agents` 由两 tab（Agents/Apps）扩为三 tab——**专家**（内置 + registry + pack 安装 + 自建预设的统一列表，自建预设的管理面迁入此处）、**行业方案**（原设置内 packs 节的市场/我的/草稿整体迁入，`requiresPackMarketplace` 门随迁）、**应用**（不变）。深链 query 参数机制保留并扩展。
- **设置 11 节 → 3 组**：迁出 presets / packs 两节；迁入 渠道接入（原 `/bots` 页作为分节渲染，管理员向）、诊断（原 `/trace` 列表作为分节渲染；`/trace/:turnId` 详情与聊天内逐轮深链保持全页路由）；分节归入 常规（通用/账户/小程序/设备）、能力（技能与工具/模型）、管理（渠道接入/诊断/系统状态/部署品牌）三组。
- **模型面收敛**：非管理员用户在设置→模型看到只读「可用模型」视图（当前 serving 名册）；供应商管理控件仅管理员可见。本地单机（auth 关）行为不变。
- **R2–R4 展望（不在本 change）**：R2 上手快（首跑引导、场景教程、上下文感知推荐提示、空状态微教程）；R3 更顺手（工作区去路径化改「项目」、自动化模板库、自然语言建任务、成果批量导出）；R4 更聪明（行业方案一键安装向导、示例画廊、小程序/App 命名同步）。R1 是它们的语言地基。

## Capabilities

### New Capabilities

（无——行为变化全部落在既有能力上）

### Modified Capabilities

- `app-navigation`: 一级 tab 集 7→5（Bots/Trace 移出导航，转为 settings 分节入口）；zh-CN 显示名按命名表更换而 tab 身份键/顺序/图标稳定性要求不变；`/agents` 面板升格为统一能力枢纽（三 tab 结构）。
- `settings-surface`: 分节清单重组——移除 packs/presets 两节，新增 渠道接入/诊断 两节；十一节平铺改为 常规/能力/管理 三组；`/settings/:section` slug 深链与旧路由重定向全部保留。
- `agent-catalog`: `/agents` 页由两 sub-tab 扩为三 sub-tab（专家/行业方案/应用），专家列表统一承载 catalog 内置、registry、pack 安装与自建预设四源并内联自建预设管理面；行业方案 tab 承接 pack 市场浏览/订阅/管理（原设置节职能整体迁移）。
- `social-bot-channels`: `/bots` 页及其 CRUD/QR 面行为不变，用户面入口由一级导航改为 设置→渠道接入 分节（托管部署管理员向）。
- `turn-tracing`: `/trace` 列表与 `/trace/:turnId` 时间线行为不变，列表入口由侧边栏改为 设置→诊断 分节；聊天内逐轮追踪深链保持直达。
- `llm-model-management`: 设置→模型 对非管理员呈现只读可用模型视图；供应商增删改/测试控件仅管理员可见。

## Impact

- `web/src/locales/*/common.json`（5 语言）— nav/设置/页面标题全套显示名 + 去术语化文案
- `web/src/components/Sidebar.tsx` — NAV_BASE 7→5
- `web/src/components/settings/sections.ts` — 分节注册表：删 presets/packs、增 channels/diagnostics、三组分组元数据
- `web/src/pages/AgentsPage.tsx` — 三 tab 重构（承载 PacksPage / CustomPresetsPage 迁入面）
- `web/src/pages/BotsPage.tsx` / `TracePage.tsx` — 分节包裹复用，路由不动
- `web/src/App.tsx` — 路由零变更（旧 slug 重定向保留）
- e2e — nav testid 稳定不动；引用 settings presets/packs 分节与两 tab 结构的用例需随迁
- 小程序/桌面 — 桌面即 web UI 零额外工作；小程序为微信原生方言、无此导航，命名同步留 R4
- custom-presets / pack-marketplace 能力行为不变（仅管理面位置迁移，由 settings-surface 与 agent-catalog delta 覆盖），不出独立 delta
