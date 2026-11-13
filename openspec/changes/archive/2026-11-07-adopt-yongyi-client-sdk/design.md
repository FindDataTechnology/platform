# 设计 — adopt-yongyi-client-sdk

## D1 发布与依赖顺序（硬前置）

SDK 先发布，壹座后换依赖；发布未完成前不动任何 import。理由：file:/git 直引在 CI（GHA 构建）不可解析仓外路径；且字节同源验收以「壹座现行输出」为金样，SDK 0.1.0 已带 4 金样自证，发布即冻结参照。发布动作 `npm publish --access public`（在 fd-memory/sdk/），卡 owner 刷新 npm token（本机 ~/.npmrc token 已 401 失效；fd-memory 无 CI 发布线，主包 0.2.0 当年系本机凭据所发）。包内容已 pack dry-run 验净（16 文件、无服务端代码）。

## D2 重接策略：纯 import 换源，行为字节钉

10 个消费文件只改 import 来源与删本地模块，不改任何调用形状：SDK 导出面按壹座现役函数名对齐（ladder 的 digestLadder/memoryInjectionFor/chatMemoryInjectionFor/chatPromptWithMemory、discipline 的 MEMORY_DISCIPLINE、facts 的 fleetMemoryFor/createFleetMemoryCapture/createHealthFlipTracker、tokens 的 cellMemoryConfig/personTokenFor/memberTokenFor/memoryMcpEntry/cellMemoryMount）。env 语义不变——SDK 把 env 读取参数化为 options（缺省值=壹座现役 `CELL_MEMORY_*` 全套），壹座调用点传 `process.env` 即逐字节等价。fail-open/degrade-open 契约由 SDK 测试钉死。

## D3 agent-runner 缺口审计结论（2026-11-07 实核）

- `agent-runner/memory-mount.js` 4 导出：`dshMemoryMount` ≈ SDK `memoryMcpEntry`（同形状）；**`memoryNamespaceFor`、`podMemoryNamespace`、`acpMemoryMount` 三件 SDK 未含**——命名空间坐标规则（metadata.agentId）与 ACP SDK wire 行（headers 数组形状）属通用件，按下沉原则先进 SDK 0.1.1（新增 `src/mounts.ts`，从 paas 逐字节移植+金样），runner 再换 import。
- `agent-runner/memory-capture.js` **保留不删**：零依赖其它记忆模块；投递目标是 fd-memory 旧 `/capture` 平台接缝面（批量+退避队列语义），与 SDK observe 客户端（单发即弃、投 `/observe`）语义不同属。它本来就是「客户」，不是「拷贝」。提案已同步修正。
- 主仓四模块（cell-memory/memory-discipline/fleet-memory/cluster-memory）无缺口：SDK 七模块全覆盖（审计对照 SDK 报告逐函数核过）。

## D4 保留面（paas 特有，明确不下放）

- `server/memory-refs.js`：资料库薄索引页（统一记忆与产出概念），壹座产品概念非通用件。
- `server/routes/memory.js`：cell Express 代理面，person 令牌铸造在服务端、浏览器不见 token——壹座铁律（secrets stay server-side）。
- runner 的 MemoryCapture 接缝（见 D3）与 manager/config/harness 三处 import 更新。

## D5 Portal 决定（推翻 tasks 7.3 简写，提案已载）

壹座 `/memory` 保留原生 React 页：①嵌入须把 person token 送进浏览器（postMessage 引导），违反铁律；②品牌/UX 分层（壹座设计系统 vs 永忆 vanilla Portal）非逻辑漂移——数据面共享；③零行为收益不值 fd-memory spec 反 churn。落地动作仅一行：页尾加独立 Portal 指引（自托管/其它 harness 用户的人面）。

## D6 测试策略

- 四测试文件重指向：从「测自有实现」改为「测接线产出与既有金样逐字节一致」（行为断言主责已在 SDK 55 测试）；`dsh-profile-memory.test.mjs` 钉 preset patch 的 mcpEntry/discipline 形状。
- 全量 `npm test` 回归 + 既有真机冒烟配方复跑（fd-memory 服务+paas 缝模块真 HTTP 全链，c83e48b 的 9/9 形状）。
- 字节钉双面：SDK 仓 4 金样（对 paas 源直比 `===` 已验）+ 壹座 4 重指向测试，两仓任一漂移即红。

## D7 风险与非目标

- 风险：SDK 未发布期间本 change 冻结（D1 硬前置）；SDK 0.1.1 mounts.ts 移植若与 paas 现役出现字节差，以 paas 为准修 SDK（金样方向不可反）。
- 非目标：旗舰深度三线程另立；Dify/Coze 适配永忆侧波次；记忆语义零变更（skip_specs）。
