# polish-facet-usability

## Why

谦面双面（`facet.finddatatech.cloud` 独立壳 + 壹座 Agents 页 Market tab 内嵌 Store）上一轮打磨（2026-10-15 polish-facet-interactions）修的是点状缺陷；本轮按用户拍板做**系统性可用性与外观收敛**：范围双面、力度「精密仪器收紧不换皮」、i18n 覆盖五语（en/zh-CN/es/fr/ja，与壹座同集同源文件）、沉淀 DESIGN.md 作为谦面外观真源。

## What Changes

- **系统层收敛（先于一切页面层工作）**：消灭双面现存 26 处 `text-[9/10/11]px` 目测字号（Store 面 23 处、壳面 3 处），立字号阶梯并下沉为全局约定；审查并收敛跨页间距任意值；动效只保留状态反馈与供示两类（加载/成功/入场），`prefers-reduced-motion` 全局豁免；`--font-sans` 补 CJK 回退序（PingFang SC / Microsoft YaHei / Noto Sans CJK）防中英混排基线漂移。
- **状态完整性**：双面全部异步视图补齐三态（加载骨架替代裸「加载中…」文字、空态给引导、错误态给重试）；壳面 CurateView/MineView 的中英混排裸文案（「加载中… / Loading…」「策展板 · Curation board」等 14+ 处）全部 i18n 键化。
- **落地页升格**：`#/` intro 的 ASCII 流程图（`creator --publish--> …` 文本行）升格为真图形（SVG/结构化布局，文案仍走五语 i18n 键、事实仍构建期可验证——不改 facet-platform spec 的静态性与事实约束）。
- **双主题层级核验**：暗色 token 全零色度导致的层级扁平问题在真机走查中按面核验，仅在证据成立处微调（light-dark 对里给 dark 侧留 chroma 余量），不动品牌蓝白基调。
- **DESIGN.md 沉淀**：facet/web + Store 面共用的字号阶梯、间距节奏、动效词汇、状态模式、语气规则落为 `facet/web/DESIGN.md`（复用组件的单一真源——两处消费同一份 web/src 源码，无需共享 npm 包）。
- **出片**：一仓一镜像（facet 是 platform 镜像第二入口 `node facet/index.js`），走 paas 标准线一条出片（`fd-build-channel` 判路 → GHA→hkccr→relay→ccr → facet.yaml 滚 tag），双面真机验收。

### 不做

- 换皮/重定品牌色与字体栈基调（用户拍板「不换皮」）；
- 谦面向导助手（`add-facet-copilot` 另立）；
- registry 控制台（mcp.finddatatech.cloud）外观——不是谦面双面之一；
- 万星控制台打磨（fd-wanxing 仓另案 polish-wanxing-console）。

## Capabilities

### New Capabilities

（无——全部是对既有能力的呈现层收敛。）

### Modified Capabilities

- `facet-platform`: ADDED「Shell views carry a complete state contract」——壳面五视图（packs/mcp/docs/mine/curate）异步数据视图的三态（骨架/空/错）与动效词汇、reduced-motion 豁免；ADDED「The intro path figure renders as a true graphic」——流程图升格为图形且保持静态、可验证、五语。
- `pack-marketplace`: ADDED「Both surfaces share a type scale and spacing discipline」——双面字号阶梯与间距纪律（禁目测字号）、共享 DESIGN.md 真源、五语键化无裸文案。

## Impact

- `web/src/components/packs/*.tsx`（Store 面：字号/间距/骨架/状态三态）；`facet/web/src/*.tsx`（壳面：IntroView 图形化、CurateView/MineView i18n 键化与三态）；`web/src/locales/{en,zh-CN,es,fr,ja}/common.json`（新键五语）；`web/src/styles/globals.css`（font-sans CJK 回退、动效 token）；`facet/web/DESIGN.md`（新）。
- 出片线：paas 标准线唯一（镜像双入口同滚）；`fd-infra-deploy` facet.yaml + platform.yaml 共滚同 tag。
- 验收：`npm --prefix facet/web build` + `scripts/check-locales.js` 五语 parity + 既有 e2e（facet-shell.spec / packs.spec）不倒退 + 双面真机走查（ego-browser，暗色+浅色+reduced-motion）。
