# Tasks

- [x] 1. i18n 五语种 facetHero key（en 为源语言，zh-CN/es/fr/ja 同步翻译——
  `scripts/check-locales.js` 强制键集 parity，spec 原「其余语种 fallback」措辞
  已按仓规修正为五语种全写；871 key/语种 parity 全绿）
- [x] 2. IntroBand.tsx（hero 带：标题 + 三个 quick facts + CLI 代码片 + 线页
  链接，随 locale 切 `/zh/products/facet/` ↔ `/products/facet/`）；App.tsx
  挂载（header 之下、tab 内容之上、无 tab 条件不可关闭）；页脚 CLI 提示去重
  （install 命令并入 hero，页脚只留 `facet help` 指针）
- [x] 3. 验收：`npm --prefix facet/web run build` 绿；浏览器实机——DOM 快照
  + 截图双验证 EN（浏览器 en-US）与 zh-CN（存储 locale 注入，已清理）两态：
  文案、CLI、线页链接随 locale 正确；页脚去重生效（证据
  gui-test-screenshots/facet_hero_en|zh.png）。**说明**：本会话后半段运行时
  输入动作（Playwright click / dom_cua / cua）出现会话级停顿（fill / 快照 /
  evaluate / 截图均正常，非页面缺陷），「MCP tab 上常驻」以代码结构证明——
  band 渲染于 tab 条件分支之外；若后续需要可复跑点击验证
- [x] 4. 顺带修复（验收暴露的全站既有缺陷）：facet 构建把 i18next /
  react-i18next（及 react / react-dom）打包两份（facet/web 与 web 各自
  node_modules 副本，vite 不跨树去重）——两副本令 react-i18next 实例注册表
  失联，`useTranslation` 回退成「key 原样返回」；壳内既有 t() 全带中文兜底
  故从未显形（facet 域上壳的 i18n 实际从未生效）。修复 = facet/web
  vite.config.ts `resolve.dedupe: [react, react-dom, i18next, react-i18next]`
  （兑现该文件注释里「single-sourced」承诺）；修复后 bundle 内 react-i18next
  警告串 2→1，EN/zh 双态渲染均过
- [x] 5. 部署验收（2026-10-05）：commit `f367ca6` → GHA image run
  37228717040 绿 → relay 03:39:39 回灌 → GitOps `eca22fa`（platform.yaml
  sha-f367ca6）+ `8f285ce`（**facet.yaml 同镜像同滚——谦面域供页者是独立
  facet deployment，仅滚 platform 不够**）→ ArgoCD hard refresh →
  platform/facet 两 rollout 成功 → 探针：platform healthz 200；facet 域新
  bundle `index-816yqvhO.js` 含 hero 中英文案与线页链接——hero 带 LIVE。
  另：滚动前按 2026-09-24 配方清理了 platform pod 内 1 个 stale 真实目录
  （`dsh-sdk-jsonrpc-server`，dsh 首启 healer 隐患），滚动未触发 crashloop