# Tasks: add-save-to-library-tool

## 1. 服务端

- [x] 1.1 `resources.js`：`storeFileCopy` 接受 `source: "model"` 与 `messageId: null`；目录拒收路径与拒因（regular file 判定复用 capture 现有逻辑）；单测或冒烟验证 model 保存与 manual/auto 同门同字节路径
- [x] 1.2 `server/routes/resources.js`：新增 `POST /api/resources/save-declared`——`ctx.dshSessionId` 归属 + 会话标题快照、每次调用 ≤10 条（超出逐条 refused 回报）、stat 判目录、复用 `storeFileCopy` 门、响应逐路径 `saved`/`already-saved`/`refused`+原因；loopback curl 冒烟覆盖：正常保存、11 路径、目录、工作区外路径、超限文件、重复内容 already-saved
- [x] 1.3 `server/auth.js`：`isInternalSaveBridge` 谓词（逐字仿 `isInternalChartBridge`）；验证非 loopback 调用被既有鉴权门拒绝

## 2. 桥与工具

- [x] 2.1 `dsh-profile-template/platform-save-library-bridge.js`：注册 `save_to_library`（`paths: string[]`，≤10 双层校验），`bridgeOrigin()` 与 chart-bind 桥同推导，结果 `textBlocks` 逐路径渲染并告知模型如何向用户转述；`dsh-profile.js` 模板组装挂载；桥单测（参数校验、超限、渲染文本）
- [x] 2.2 `skills/platform-output-contract/SKILL.md`：加交付即调条款（markdown 链接交付的文件同回合调用工具；saved/already-saved 后勿重调）；文案保持 baseline-skill 体量

## 3. 测试与验证

- [x] 3.1 端到端手测或 e2e：回合内脚本写文件 → 模型调 `save_to_library` → 成果页出现 `source=model` 资源（会话级溯源、无 message 引用）；同内容再调返回 already-saved 不重复立行
- [x] 3.2 回归确认：用户手动保存、自动捕获两条既有入口行为不变（同门去重共存）
- [x] 3.3 `openspec validate add-save-to-library-tool --strict` 通过；相关单测/e2e 全绿
