# web/

Platform 的 React 聊天界面。本目录是自包含的 Vite + React + TypeScript 工作区；仓库根目录的 Node 后端不受迁移影响。

- **定位**：Platform 的唯一前端 —— 一个 React SPA（Vite + React 19 + TypeScript + Tailwind v4 + shadcn 风格原语 + `react-router-dom`），承载所有视图。Markdown 渲染、代码高亮，以及把 thinking / tool / skill 块按产出它们的 assistant 分组展示的对话轮次。旧的 vanilla `public/` 目录已删除。
- **路由**：`/chat`（默认）、`/chat/:sessionId`、`/knowledge`、`/dashboard`、`/mcp`、`/skills`、`/models`、`/trace`、`/trace/:turnId`、`/agents`、`/bots`、`/external/:appId`。除 `/external/:appId` 外全部是一方 React 页面；`/external/:appId` 把目录（`agents.json`）里声明的 `external-service` 应用以 `<iframe>` 嵌进同源的 `/external/:appId` 代理，token 由服务端注入、不进浏览器。
- **页面结构**：`src/pages/`（`ChatPage`、`DocumentsPage`、`DashboardPage`、`ExtensionsPage`、`ModelsPage`、`TracePage`、`AgentsPage`、`BotsPage`、`EmbeddedServicePages`）。状态放在 `src/hooks/` 的 zustand store（`useChatStore`、`useDocumentsStore`、`useExtensionsStore`）；API 客户端在 `src/lib/`。侧边栏（`src/components/Sidebar.tsx`）用 `<NavLink>` 做应用内导航，跨视图不重载、WebSocket 保持连接。
- **国际化（i18n）**：用 react-i18next，语言文件在 `src/locales/{en,zh-CN,es,fr,ja}/common.json`。`en` 是源与默认，`zh-CN` 等是并行翻译。活动语言在启动时解析（本地存储选择 → 浏览器语言最佳匹配 → `en`），见 `src/i18n/config.ts` 与 `src/i18n/useLanguage.ts`。
- **规范**：`openspec/changes/port-views-react-bundle-dmg/`。

## 快速开始

```bash
# 从仓库根目录
npm install          # postinstall 自动把 web/ 构建到 web/dist/
npm start            # 在 / 提供 React SPA（唯一前端）
```

然后打开 <http://localhost:3000/>。

### 前端开发

对着 Vite 开发服务器迭代，改动即时热重载：

```bash
npm run web:dev
# Vite 在 http://localhost:5173/
# Node 后端必须同时在 :3000 运行；开发服务器把 /api 与 /external
# 代理到它，WebSocket 由客户端在运行时直连 :3000（见 src/hooks/useWebSocket.ts）。
```

### 跳过构建

CI 或不想让 postinstall 触发前端构建的贡献者：

```bash
PLATFORM_SKIP_WEB_BUILD=1 npm install
```

如果 `web/dist/index.html` 已存在，`npm install` 也不会重建它。

## 目录结构

```
web/
├── package.json            # 仅前端依赖
├── vite.config.ts          # base: "/"、开发代理（/api、/external）
├── tsconfig.json           # strict、noUncheckedIndexedAccess
├── components.json         # shadcn CLI 配置（备用）
├── index.html              # Vite 入口
└── src/
    ├── main.tsx            # ReactDOM 根
    ├── App.tsx             # 外壳：路由 + 侧边栏 + 聊天
    ├── styles/globals.css  # Tailwind v4 @theme tokens
    ├── lib/utils.ts        # cn()（shadcn 约定）
    ├── lib/documents-api.ts    # 文档 REST 客户端
    ├── lib/extensions-api.ts   # 扩展管理 REST 客户端
    ├── types/ws.ts         # WebSocket 消息类型（事实来源）
    ├── types/electron.d.ts # window.platform 桌面桥类型
    ├── i18n/               # react-i18next 配置 + useLanguage hook
    ├── locales/            # en / zh-CN / es / fr / ja 的 common.json
    ├── hooks/
    │   ├── useChatStore.ts      # Zustand store，每个 WS 类型一个 reducer
    │   ├── useDocumentsStore.ts
    │   ├── useExtensionsStore.ts
    │   └── useWebSocket.ts      # 连接 + 重连
    ├── pages/
    │   ├── ChatPage.tsx
    │   ├── DocumentsPage.tsx
    │   ├── DashboardPage.tsx
    │   ├── ExtensionsPage.tsx
    │   ├── ModelsPage.tsx
    │   ├── TracePage.tsx
    │   ├── AgentsPage.tsx
    │   ├── BotsPage.tsx
    │   └── EmbeddedServicePages.tsx  # ExternalService 应用的 iframe 封装
    └── components/
        ├── Sidebar.tsx
        ├── Chat.tsx
        ├── UserTurn.tsx
        ├── AssistantTurn.tsx
        ├── ThinkingBlock.tsx
        ├── ToolBlock.tsx
        ├── SkillBlock.tsx
        ├── Markdown.tsx        # react-markdown + shiki（懒加载）
        ├── Composer.tsx
        └── Toast.tsx
```

## 添加 shadcn 组件

`components.json` 让 CLI 直接可用：

```bash
cd web
npx shadcn@latest add dialog
# → 生成 web/src/components/ui/dialog.tsx
```

组件随仓库源码保存 —— 我们拥有它们，无需 bump 运行时 shadcn 依赖。

## 打包说明

Shiki 是最大的单一依赖。为控制体积，我们从 `shiki/core` 与显式的 `@shikijs/langs/*` 语法导入 —— 默认的 `shiki` 入口会引入包内所有语言（约 15 MB）。若需要新的围栏语言，把它加到 `src/components/Markdown.tsx` 的 `LANGS`。

## 保留的契约

- `ws://<host>/` 上的 WebSocket 处理与后端一致的消息集（客户端 `prompt`、`list_models`、`set_model`、`list_skills`、`list_sessions`、`new_session`、`switch_session`、`set_workdir`；服务端推送 `user`、`agent_start`、`text`、`thinking`、`tool_*`、`skill_use`、`command_use`、`sessions`、`session_loaded`、`session_changed`、`workdir`、`models`、`current_model`、`model_changed`、`skills`、`done`、`error`，外加 dashboard / cron / documents / extensions 事件）。完整清单见 `src/types/ws.ts`。
- `/api/*` 下的 REST 端点不变。
- WebSocket + REST 契约不变 —— React 应用访问同一 `ws://<host>/` 与 `/api/*`。

---

# English

React chat surface for the Platform. This directory is a self-contained Vite + React + TypeScript workspace; the Node backend under the repo root is untouched.

- **Purpose**: the sole frontend — a React SPA (Vite + React 19 + TypeScript + Tailwind v4 + shadcn-style primitives + `react-router-dom`) hosting every view. Markdown rendering, code highlighting, and turns that group thinking / tool / skill blocks under the assistant that produced them. The legacy vanilla `public/` directory has been deleted.
- **Routes**: `/chat` (default), `/chat/:sessionId`, `/knowledge`, `/dashboard`, `/mcp`, `/skills`, `/models`, `/trace`, `/trace/:turnId`, `/agents`, `/bots`, `/external/:appId`. Everything except `/external/:appId` is a first-party React page; `/external/:appId` embeds an `external-service` app declared in the catalog (`agents.json`) as an `<iframe>` over the same-origin `/external/:appId` proxy, with tokens injected server-side so none reach the browser.
- **Page structure**: `src/pages/` (`ChatPage`, `DocumentsPage`, `DashboardPage`, `ExtensionsPage`, `ModelsPage`, `TracePage`, `AgentsPage`, `BotsPage`, `EmbeddedServicePages`). State lives in `src/hooks/` zustand stores (`useChatStore`, `useDocumentsStore`, `useExtensionsStore`); API clients in `src/lib/`. The sidebar (`src/components/Sidebar.tsx`) uses `<NavLink>` for in-app navigation so the WebSocket stays connected across views.
- **i18n**: react-i18next; locale files in `src/locales/{en,zh-CN,es,fr,ja}/common.json`. `en` is source-of-truth and default; `zh-CN` etc. are parallel translations. The active locale resolves at boot (stored choice → browser best match → `en`) — see `src/i18n/config.ts` and `src/i18n/useLanguage.ts`.
- **Spec**: `openspec/changes/port-views-react-bundle-dmg/`.

## Getting started

```bash
# From the repo root
npm install          # postinstall builds web/ into web/dist/ automatically
npm start            # serves the React SPA at / (sole frontend)
```

Then open <http://localhost:3000/>.

### Working on the frontend

```bash
npm run web:dev
# Vite on http://localhost:5173/
# The Node backend must ALSO be running on :3000; the dev server proxies
# /api and /external to it, and the client connects the
# WebSocket directly to :3000 (see src/hooks/useWebSocket.ts).
```

### Skipping the build

```bash
PLATFORM_SKIP_WEB_BUILD=1 npm install
```

If `web/dist/index.html` already exists, `npm install` won't rebuild it either.

## Layout

```
web/
├── package.json            # frontend-only deps
├── vite.config.ts          # base: "/", dev proxy (/api, /external)
├── tsconfig.json           # strict, noUncheckedIndexedAccess
├── components.json         # shadcn CLI config
├── index.html              # Vite entry
└── src/
    ├── main.tsx            # ReactDOM root
    ├── App.tsx             # shell: routes + sidebar + chat
    ├── styles/globals.css  # Tailwind v4 @theme tokens
    ├── lib/utils.ts        # cn()
    ├── lib/documents-api.ts
    ├── lib/extensions-api.ts
    ├── types/ws.ts         # WebSocket message types (source of truth)
    ├── types/electron.d.ts # window.platform bridge types
    ├── i18n/               # react-i18next config + useLanguage hook
    ├── locales/            # en / zh-CN / es / fr / ja common.json
    ├── hooks/
    │   ├── useChatStore.ts
    │   ├── useDocumentsStore.ts
    │   ├── useExtensionsStore.ts
    │   └── useWebSocket.ts
    ├── pages/
    │   ├── ChatPage.tsx
    │   ├── DocumentsPage.tsx
    │   ├── DashboardPage.tsx
    │   ├── ExtensionsPage.tsx
    │   ├── ModelsPage.tsx
    │   ├── TracePage.tsx
    │   ├── AgentsPage.tsx
    │   ├── BotsPage.tsx
    │   └── EmbeddedServicePages.tsx  # ExternalService iframe wrapper
    └── components/
        ├── Sidebar.tsx
        ├── Chat.tsx
        ├── UserTurn.tsx
        ├── AssistantTurn.tsx
        ├── ThinkingBlock.tsx
        ├── ToolBlock.tsx
        ├── SkillBlock.tsx
        ├── Markdown.tsx
        ├── Composer.tsx
        └── Toast.tsx
```

## Adding a shadcn component

```bash
cd web
npx shadcn@latest add dialog
# → drops web/src/components/ui/dialog.tsx
```

Components are source-in-repo — we own them.

## Bundle notes

Shiki is the biggest single dependency. We import from `shiki/core` and explicit `@shikijs/langs/*` grammars — the default `shiki` entry point would pull in every language (~15 MB). Add new fenced languages to `LANGS` in `src/components/Markdown.tsx`.

## Contracts we preserve

- The WebSocket at `ws://<host>/` handles the same message set as the backend (client `prompt`, `list_models`, `set_model`, `list_skills`, `list_sessions`, `new_session`, `switch_session`, `set_workdir`; server `user`, `agent_start`, `text`, `thinking`, `tool_*`, `skill_use`, `command_use`, `sessions`, `session_loaded`, `session_changed`, `workdir`, `models`, `current_model`, `model_changed`, `skills`, `done`, `error`, plus dashboard/cron/documents/extensions events). Full list in `src/types/ws.ts`.
- REST endpoints under `/api/*` are unchanged.
