## 1. 校验器（shape 层）

- [x] 1.1 `lib/pack-manifest.js` 接受 `fullSurface`（布尔）与 `fullSurfaceReason`（非空字符串），并拒绝与 `allowTools` 同时出现；验证：`scripts/test-pack-cell.mjs` 新增三例（只 fullSurface 通过、两者并存失败、理由为空失败）
- [x] 1.2 shape 层保持接受"无声明"的引用（安装兼容）；验证：一份无声明的旧 manifest 在 `installPack` 路径仍然通过
- [x] 1.3 `PACK_LIMITS` 不变（`maxToolsPerMcp=64`）；验证：65 个名字仍被拒

## 2. 发布门

- [x] 2.1 publish 端加"每个引用必须有 `allowTools` 或 `fullSurface`"的门，错误点名 pack/server 与两种修法；验证：新增 publish 用例断言 400 与错误文本
- [x] 2.2 工具级闭包：从技能正文抽取 `mcp__<server>__<tool>`，断言落在该引用的 `allowTools` 内，`fullSurface` 豁免；验证：新增用例覆盖"点名但未声明"失败与"fullSurface 豁免"通过
- [x] 2.3 既有名字校验保持不变（快照存在性、实时探测兜底、UNRESOLVED 语义、commercial 闭合、本地绑定豁免）；验证：既有 publish 用例全绿
- [x] 2.4 加环境开关 `PACK_TOOL_FACE_GATE`（`off|warn|enforce`，默认 `warn`）；验证：`warn` 下违规发布成功但记录一条结构化日志，`enforce` 下被拒
- [x] 2.5 回填前预检（跨仓波次的放行依据）：用作者仓重生成后的 34 份 manifest 离线跑既有的 `declaredToolsByServer` + `registryServerIndex()` + `toolGateErrors`，输出每个被引用 server 的 `tool_list` 覆盖数、missing 名单与探针可达性；快照滞后的先走 registry 的 `POST /api/refresh/<path>` 刷新再复跑；验证：13 个被引用 server 无 UNRESOLVED 残留，预检报告存档后才允许开第一波

## 3. 详情页披露

- [x] 3.1 详情页渲染每个 MCP 引用的"声明 N / 全量 M"（数据来自版本 manifest + catalog `tool_list`）；验证：Playwright 断言 `wire-ic-debate` 类 pack 显示声明数与总数
- [x] 3.2 `fullSurface` 引用渲染理由文本；验证：fixture pack 详情页显示理由
- [x] 3.3 旧版本（两者皆无）渲染为"全量（未声明）"且页面正常；验证：fixture 旧版本详情页不报错

## 4. 编辑器

- [x] 4.1 草稿允许"未选工具"保存；验证：保存后重新打开仍是未选状态
- [x] 4.2 未选工具时提供"标为全量 + 理由"的显式控件；验证：填写后草稿带 `fullSurface`/`fullSurfaceReason`
- [x] 4.3 发布前本地预检复用同一规则，缺口就地提示；验证：缺声明时点发布被前端拦下并指出具体 server

## 5. 灰度与验收

- [ ] 5.1 `warn` 模式上线一周，收集违规面；验证：日志中列出所有会失败的引用
      → **未形成观察窗**：核实生产时开关已是 `enforce`（2026-10-20T09:35:43Z 由 `kubectl-patch` 更新，
      facet 无 `warn-only` 日志）。替代依据：回填前 registry 预检 34 份 / 11 server /
      `faceViolations=0` / `unresolved=0`，作者仓批次 2026-10-20T02:00Z 前后收尾。
- [x] 5.2 依赖作者仓回填完成，切 `enforce`；验证：一次合法发布成功，一次故意缺声明的发布被拒且错误含两种修法
      → 生产验证走 `/api/packs/validate`（与发布同一收集器）：未声明引用返回 `toolFace: true` + 两种修法；
      `fullSurface` + 理由返回 `valid: true`。见 `measurements.md` §2。
- [x] 5.3 安装一份回填前的旧版本，确认仍可安装并渲染"未声明"；验证：e2e 断言安装报告与详情页
