# Tasks: polish-desktop-fleet-parity

## 1. 桌面差异点普查（spike，先做）

- [x] 1.1 逐条实操核对五项（单用户 owner 归属 / cron 时区与停机补跑 / 引导与关窗驻留交互 / boards 与驾驶舱空态 / 无登录跳转），每条给出「修 或 挂账」判定并留证据（截图或日志），结论补记进 design.md
- [x] 1.2 官方种子真源定位完成：**`docs/fleet-templates/*.seed.json`**（公司式/客服/情报简报/投资晨报/内容工厂五份）——预置 bundle 由这份清单铸造，仓内文件仍是唯一真源（不产生第二编辑入口）

## 2. 预置种子登记（消费方）

- [x] 2.1 预置登记：`GET /api/wanxing/fleet/presets` 只列目录不安装（元信息：packId/版本/名称/出处/体积）；`server/preset-bundles.js` 经 `PLATFORM_RESOURCES_DIR` 解析目录；无目录/空目录零行为变化（`scripts/test-preset-bundles.mjs` 6 测试全绿）
- [x] 2.2 预置 bundle 的 fleet 段与仓内种子真源一致性断言并入守恒测试族（烘焙产物不产生第二真源）

## 3. 首启引导步

- [x] 3.1 tour 追加桌面步（`IS_DESKTOP` 判定 + 仅当本机无集群时出现）：锚在舰队导航项，卡片内「装上入门包」一键走 `presets/import`；卡片不挡操作/Escape/可跳过；浏览器仍恰好三步（既有断言不改）
- [x] 3.2 取样例双源：预置 bundle 优先、市场兜底；安装保持一次显式确认（不静默物化）；每步失败精确到步给出引导，不整段报错
- [x] 3.3 桌面步 done 标记独立键 `onboarding.tour.desktop.done`（不破坏既有三步骤标记语义）；**顺带补齐此前整体缺失的 `onboarding.tour.*` 命名空间**（原页面显示原始 key），五语言同批，locale 闸绿（2274 key × 5）

## 4. 离线模板可用性

- [x] 4.1 离线来源在已装列表可见：`installed_packs.source` 列（market|bundle，历史行默认 market）+ 已装包卡片「离线」徽标；离线模板与市场模板同属已装 pack，实例化器（`FleetTemplateWizard`）走同一路径与同一降级规则

## 5. 见证

- [x] 5.1 首启引导的桌面步与预装登记并入平台中立探针（`electron/local-cluster-probe.mjs`：预装包登记可见 + 导入 → 已安装），两腿共用；**双平台已双绿**：预装包登记与导入在两腿通过（run `40676023413` / `40678629642`） —— **待 CI 腿（本地无法跑双平台）**
- [x] 5.2 spike 五项判定已随 change 记录（design.md「桌面差异点判定」节：三项现状可用、一项本 change 补、一项已有 spec 覆盖）。**人工肉眼走查已完成**（2026-10-29，模型具备图像输入后补做）：四张截图（已部署/满载/409 引导/云目录只读）逐张过目，**视觉验收通过**；逮出一处英文单复数小疵（`fleet.live.summary`「1 agents」）当场修掉（i18next 复数键 summary_one/other，五语言 + key parity 过 locale 闸）。四张截图交付 `~/paas-artifacts/v1.3.24/fleet-ui/index.html`（已更新为修复后版本）
- [x] 5.3 `openspec validate polish-desktop-fleet-parity --strict` 绿；`scripts/test-preset-bundles.mjs` 6 例全绿；locale 闸 2274 key × 5 绿；tsc 绿
