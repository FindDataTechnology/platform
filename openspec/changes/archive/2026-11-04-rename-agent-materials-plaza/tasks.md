## 1. 词汇 v5 显示层落地（零 API 改）

- [x] 1.1 壹座 web 五语 locale：`packs.tabs.market`、footer `entries.packs`、app-center tagline、855 starterNote、1131 desc、2598 savedAs 的显示值改「智能体素材广场」/ "Agent Materials Plaza"（es/fr/ja 等义），键零改 —— 验证：`node scripts/check-locales.mjs`（或仓内等价 parity 门）5 绿；`grep -rn "智能体市场" web/src/locales/` 零命中
- [x] 1.2 facet shell 键：`facetIntro.title/subtitle` 改素材广场口径（五语平行）—— 验证：同上 parity 门绿；facet web `npm run build` 成功
- [x] 1.3 全仓旧名扫尾：`grep -rn "智能体市场\|Agent Market\|壹座·智能体基础设施\|Agent Infrastructure" web/src facet/ app/src miniapp/src electron --include="*.json" --include="*.tsx" --include="*.ts"` 除 spec/archive 与注释性历史记录外零残留 —— 验证：grep 输出仅剩 openspec 主 spec（历史条文）与 archive
- [x] 1.4 `CONTEXT.md` 新增「素材广场（Materials Plaza）」与「素材（Material）」两条词条，Avoid 列表含插件市场、应用商店、资源广场 —— 验证：词条存在且与 native-lexicon v5 措辞一致

## 2. 门与验证

- [x] 2.1 `openspec validate rename-agent-materials-plaza --strict` 零 error —— 验证：CLI 输出
- [x] 2.2 全仓测试无新增红（locale 值改动不触碰逻辑，跑既有 unit 冒烟即可）—— 验证：红名单与 pristine HEAD 同点
- [x] 2.3 生产走查（随下次出片）：壹座市场 tab 页头、facet 页脚入口、app-center 卡片眼见「素材广场」终词 —— 验证：真机截图/台账 §9 记录【已闭：platform sha-d6b8323 上产，in-pod+公网 chunk 双 grep 实证（新词在旧词零残留），台账 §9 补记】
