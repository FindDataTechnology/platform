# lawcraw

  后端

  - Runtime: Node.js (ESM 模块，无转译/打包，原生 buildless 开发)
  - Framework: Express 4.x
  - WebSocket: ws 8.x
  - AI 运行时: DeepSeek Harness (dsh) —— 通过 @deepseek-ai/dsh-sdk-client 以 stdio JSON-RPC 子进程方式驱动
  - RAG: LlamaIndex.TS (文档索引/检索)
  - MCP: dsh 一方插件 @deepseek-ai/dsh-mcp-client (Model Context Protocol 集成)
  - 存储: better-sqlite3, 文件系统 (原子写入)
  - 其他: multer (文件上传), dotenv (环境配置), undici (HTTP), node-schedule

  前端 (迁移中)

  - 旧版: 原生 Vanilla JavaScript + CSS (无框架，当前在 /)
  - 新版 (Chat 视图): React 19 + TypeScript + Vite (当前在 /chat)
    - Tailwind CSS v4 + class-variance-authority
    - shadcn/ui 风格组件
    - shiki (代码高亮，按需加载)
    - react-markdown + remark-gfm (Markdown 渲染)
    - zustand (状态管理)
    - lucide-react (图标)

  桌面端

  - Electron 43.x + electron-builder (打包为 macOS .dmg)
  - 架构: Electron 作为进程监督器，动态端口分配，健康检查后启动后端子进程

  LLM 接入

  - Volces/火山引擎: 默认 LLM 提供者
  - 路由配置: dsh 一方的 dsh-llm 插件，读 $DSH_HOME/settings.yaml + .credentials.yaml（热重载）
  - 外部 MCP server: 按需在 mcp.json 里声明，由 dsh-mcp-client 接入

  开发工具

  - Playwright (E2E 测试)
  - OpenSpec (v1.4.1): 规范驱动开发工作流
  - TypeScript (类型检查)
  - tsx (TypeScript 执行)

  这是一个绿场项目，后端保持零构建，前端聊天界面正在从原生 JS 迁移到 React + TypeScript + Tailwind v4。



  # lawcraw-server



  


