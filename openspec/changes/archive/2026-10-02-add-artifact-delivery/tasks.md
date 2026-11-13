# Tasks: add-artifact-delivery

## 1. 产物契约基线

- [x] 1.1 Go/no-go 核验技能加载语义：在 `skills/` 放探针技能，真跑一轮 dsh 会话，确认 system prompt 至少含 description 行（启动全文或按需摘要均可接受）。结论记入本条备注；若 description 行不可靠，按 design D1 切换 bridge 注入路径并回填设计文档
  - 备注：**GO**。静态核验 dsh-tool-skill（catalog 源码）：技能目录以 `- name: description` 摘要行恒驻 system prompt（500 字符截断上限），正文按需加载——description 行自足设计成立，无需 bridge
- [x] 1.2 编写 `skills/platform-output-contract/SKILL.md`：frontmatter description 一行写全三条硬规则（echarts 围栏 / 工作区相对路径链接 / 禁 data: URI 与"无能力"话术），正文 ≤40 行含正反例；验证：脚本断言 description 同含 `echarts`、相对路径、`data:` 三个关键词（断言归并至 §5.3 守卫脚本 `scripts/test-artifact-contract-guard.mjs`）
- [x] 1.3 远程 fork 单行 system message（`server/agent-session.js` 的 remote fork 路径）追加契约行；验证：单测断言该消息文本含契约关键词（断言归并至 §5.3 守卫脚本）
- [x] 1.4 样本包去 Mermaid 化：`docs/vertical-packs/skills/china-macro-brief-workflow/SKILL.md` 与 `legal-case-workflow/SKILL.md` 的图表引导改为 echarts JSON 围栏示例；验证：两文件 grep 无 mermaid 引导、含 echarts 示例（归并至 §5.3 守卫脚本）

## 2. 镜像规范化（chat-history 漏斗）

- [x] 2.1 实现 `normalizeFunctionalRefs(text, workspaceRoot)` 纯函数：data: URI 链接（命中同内容工作区文件→改相对链接；未命中→降级纯文字）、工作区内绝对路径链接→相对；验证：单测覆盖命中/未命中/内外路径/幂等（`scripts/test-artifact-normalize.mjs`，14/14 绿）
- [x] 2.2 实现有界工作区遍历 helper（跳过 `node_modules`/`.git`、单文件 ≤ `RESOURCE_MAX_FILE_BYTES`、文件数上限 500，超限即降级）；验证：单测覆盖超限与跳过目录（同上，含 520 文件 cap 用例）
- [x] 2.3 接入 `recordMessage` 单一漏斗（本地/远程/cron 三路径同过）；验证：单测断言镜像路径 assistant 文本被规范化、user 文本不动、内联代码与正文原样；既有 resources 回归 37/37 绿

## 3. 入藏角标（chat-chart-rendering）

- [x] 3.1 围栏→规范 JSON→sha256 的内容哈希规范化函数提升 `packages/core`（`chart-fence.ts`：extractChartFences / canonicalChartHash / chartHashesInText，WebCrypto 双端同码），服务端 `captureFromMessage` 与客户端角标共用同一规则；验证：`scripts/test-chart-fence-hash.mjs` 断言五类围栏（空白/unicode/嵌套/重复键）的捕获行 `content_hash` 与 core 计算一致（3/3 绿）
- [x] 3.2 网页 EChart 块常驻角标：哈希 ∈ 资源库行集合则渲染"已入资源库"角标，点击跳资源库页；无匹配不渲染占位；验证备注：web 无组件测试基建（house 惯例=e2e+node 单测），有/无匹配两态由 e2e 场景重放断言（已入藏图表恰 1 角标 + 未入藏围栏无角标）
- [x] 3.3 角标实时性：搭 `resources_changed`→`useResourcesStore` 现有订阅便车（store 新增 eventSeq 计数），捕获后免刷新重查；验证备注：eventSeq 重查机制由 e2e"存入→chip 免刷新翻转"同路径验证（useChartCaptured 与 usePathSaveStates 共用该机制）

## 4. 本轮产物条带（resource-library-ui）

- [x] 4.1 `findFilePath` 路径扫描器从 `web/src/lib/file-preview.ts` 提升 `packages/core`，web 引用切换；验证：web typecheck 绿 + 既有 e2e 25/25（session-open/resources-page/chat-history/chat-chart-rendering）
- [x] 4.2 新增 `POST /api/resources/lookup`：body `{paths[], hashes[]}`（哈希问询服务角标，泛化自原 `{sessionId, paths[]}` 设计——sessionId 服务端无需，见 design D4），会话工作区 containment（realpath 收容，沿用 saveFile 纪律）、批量读文件求哈希比对库内 `content_hash`；验证：API 单测覆盖命中/未命中/越权拒绝/读失败/超限/非文本 data: URI（`scripts/test-resources-api.mjs` +9 断言组，9/9 绿）
- [x] 4.3 网页条带组件：回合 tool 事件路径提取→按路径去重末次为准→两态 chip（预览 + 存入资源）；验证备注：组件测试基建不存在，去重/两态/存入翻转由 e2e 场景重放断言（chip 出现→存入→免刷新翻转已存）
- [x] 4.4 历史会话渲染与不持久化：重开会话条带照常推导；验证：e2e 断言重载后 DB 消息内容原样（无条带痕迹、围栏完整）、重开两轮条带与角标重推导出现
- [x] 4.5（实现中发现，范围新增上报）修复 Sidebar welcome 陷阱：live 会话==点击行且视图为空（新标签页/无参重载）时，行点击被 `s.id !== currentSessionId` guard 吞掉、transcript 不可达且深链效果同 id 不触发——改为空视图时对当前行也发 `switch_session`（服务端同 id 分支本就返回 transcript）；e2e 场景重放的第二/三次 openSession 即此路径的行为断言

## 5. 验收与发布守卫

- [x] 5.1 主线 e2e「场景重放」（`e2e/artifact-delivery.spec.js`，无 LLM、SQLite 直插种子）：开历史会话→图表渲染+角标（已入藏恰 1、未入藏 0）→角标点击跳 /resources 且图表行可见→重开会话→条带 chip（正文未挂链接仍交付）→存入→免刷新翻转已存→DB 消息内容原样无条带痕迹→再重开角标/条带/已存态全重推导；断言 UI 链路不断言模型话术；验证：e2e 绿（761ms）
- [x] 5.2 回归：新增+资源系单测 61/61 绿；受影响 e2e（session-open/resources-page/chat-history/chat-chart-rendering）25/25 绿；`openspec validate add-artifact-delivery` 通过
- [x] 5.3 守卫脚本 `scripts/test-artifact-contract-guard.mjs`（5/5 绿）：①基线技能 description 含三硬规则且 ≤500 字符（目录摘要截断上限）②远程 fork system message 含契约关键词 ③两样本包 SKILL.md 无 Mermaid 引导含 echarts ④Dockerfile 以整目录 COPY skills/（无扩展名 glob）且 .dockerignore 不排除 ⑤技能文件 frontmatter 可解析
