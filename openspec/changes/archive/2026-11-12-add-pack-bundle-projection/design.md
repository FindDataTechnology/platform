## Context

见 `proposal.md — Why`。实现要贴着既有事实：

- `.yizpack` 的导出已经要求确定性（"条目序与时间戳归一"），且导入侧的摘要校验是成熟的：`offline-pack-supply` 的"摘要不符整体拒绝，不落半包"。**这就是三封信封的锚**——第一封已存在且已有金样判据。
- 桌面预置的实际烘焙在 `scripts/bake-bundles.mjs`：读 `bundles/manifest.json`（`{bundles:[{file}]}`）→ 逐个 `readBundle` 全量重校验（zip 形状、摘要、路径安全）→ 重建 `resources/bundles/`。它已经是"fail fast + 幂等 + 无后门"，只是**列表是人写的**。
- 市场里的 manifest 内嵌技能正文（`skills[].content` / `skills[].files`），安装管线直接从 manifest 取用——所以"信封内容 = manifest 快照的子集"这件事在数据上是成立的，不需要再拉一遍资源。
- 包内容边界已经由 `lib/pack-manifest.js` 定义（MCP 只能是 `registryName` 引用、agent 只能是 persona、serving 只声明约束不含端点/凭据）。投影的"出走去什么"本质上是这条边界的**再收窄**，不是新边界。
- 裸 dsh 没有 fleet 概念；dsh profile 由 `package.json` 的 `dsh.profile.bundles` + patch 层组成。因此 dsh 信封只能是能力载体，不能带编排。

## Goals / Non-Goals

**Goals**

- 一个生成器、一份中间表示、三个适配器；改 manifest 一处，三封信封同步。
- 漂移由产物摘要判定，且**源路径无关**（避开 drift-guard 硬编码 `REPO/mf/manifest.json` 那类盲点）。
- 出走内容可被第三方安全消费：无端点、无凭据、无平台内部标识。

**Non-Goals**

- 不做向外部市场（npm scope / 任何 registry）的**发布动作**：本变更只产文件与兼容声明，发布渠道另行变更。
- 不做反向导入（别人的 dsh bundle → 我们的 pack）：那是"消费向"，必须先有三道闸（`harden-plugin-supply-gates`）。
- 不改 `.yizpack` 字节格式，不改导入/付费闸。

## Decisions

**D1. 中间表示（IR）是纯函数产物：`manifest snapshot → { skills[], personas[], mcpRefs[], displayMeta }`，三个信封都是 IR 的适配器。**
替代方案：三个生成器各自读 manifest。否决理由——三份裁剪规则必然漂移，而"哪一项能出走"是安全边界，不能有三份实现。

**D2. dsh 信封不产出任何会接管加载顺序的层。**
替代方案：顺手生成 `cordis.patch.yml` 把技能挂上。否决理由——patch 层能 insert 加载项，等价于接管运行时；一旦第三方市场里的包带上它，就和"运行期不装、不改运行时配置"的纪律冲突。信封只提供被加载的东西（skills/presets），由消费方决定怎么挂。

**D3. 兼容范围用声明而非猜测：信封带 `dshCompat: ">=0.2.0-rc.2 <0.3"` 这类范围，生成器只做语法与"当前矩阵是否落在范围内"的校验。**
替代方案：不声明，任由消费方踩。否决理由是 dsh 仍在 rc 阶段，版本耦合必须在制品里写明，不能只写在我们的文档里。

**D4. 漂移检查用 `--check` 模式 + 产物摘要，不用文件 mtime/路径匹配。**
理由：drift-guard 的盲点是"源路径硬编码"，实读一边是市场 API。摘要判据天然免疫源位置变化。

**D5. 切到生成清单之前，先把"生成结果 == 现手工清单"作为一次显式比对。**
理由：如果今天手写的 `bundles/manifest.json` 与生成器结果不同，那不是重构而是**内容变更**（会改变出货预置包）。这条比对必须先做、结果要人看一眼。

## Risks / Trade-offs

- **[dsh 信封格式随上游 rc 变动]** → `dshCompat` + 兼容矩阵 + 一条"范围外即拒"的生成器校验；升级时只改矩阵，不改信封结构。
- **[三封信封并非同构，边界规则可能被"临时特例"侵蚀]** → 边界规则只写在 IR 一处，适配器不得二次裁剪；测试用"含 fleet/console/端点的 manifest 必须三封齐拒"来钉住。
- **[生成清单与手写清单不一致导致预置内容变化]** → D5 的显式比对，差异需单独评审后才切换。
- **[摘要确定性被环境破坏（换行/编码/时间戳）]** → 确定性测试跑两次并比摘要；CI 在 Linux 与 macOS 各跑一次。
- **[投影器变成"发布流程的一部分"从而阻塞发布]** → 投影是离线步骤，发布面不调用它；CI 只跑 `--check`。

## Migration Plan

1. 先落 IR 与三个适配器，`--check` 模式可用但**不接 CI**、不改烘焙：此时只是多了一个可运行的生成器。
2. 跑 D5 比对，人工确认生成 = 现有预置内容（或确认差异可接受）。
3. `bake-bundles.mjs` 切到生成清单；CI 接 `--check`。
4. 回滚：烘焙切回手写清单（清单文件保留在仓库），CI 摘掉 `--check`；三信封产物本身不影响运行时。

## Open Questions

- dsh 信封的包名与 scope（`@finddata/...` 还是 `@platform/...`）待定，不改变契约，落地时定。
- 是否把 `--check` 扩展成"顺带产出市场条目预览"（便于人工看差异），可后续加。
