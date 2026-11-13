# Tasks

## 1. i18n 键组（五语种）

- [x] 1.1 介绍视图键组落 `web/src/locales/en/common.json`（源语言）：hero（H1 / 副标 / 事实行 /
  双 CTA）、三特性卡（标题 + 正文）、路径图三行、快速开始（命令 + 两枚可选参数）、线页回链；
  页脚键组：品牌标语、联系标签与两项、产品线标签、阶梯五行（双字方章 + 汉字数字 + 契约线名）、
  当前站点、入口四项、使命句、版权与两条备案——验证：`node scripts/check-locales.js` 先报
  zh-CN/es/fr/ja 缺失键清单（先红）
- [x] 1.2 zh-CN / es / fr / ja 同步翻译，键集与 en 逐键一致；zh-CN 使命句逐字
  「寻数科技聚焦AI时代下的文本和数据处理的基础设施建设，致力于推动信息平权，最终促进社会公平。」；
  en 源句 "FindData builds text- and data-processing infrastructure for the AI era, advancing
  equal access to information and, ultimately, social equity."；es/fr/ja 对译；方章汉字在所有
  语种保留，线名列非中文语种用英文概念词（Base/Lex/Wire/Facet/Constellation）——验证：
  `node scripts/check-locales.js` 五语种 parity 全绿

## 2. 壳：hash 路由 / 文本方章 / 语言切换器

- [x] 2.1 `facet/web/src/App.tsx` 引 hash 路由：`#/`（介绍）/ `#/packs`（功能集市场）/
  `#/mcp`（MCP 服务）；hashchange 监听 + 首载解析 + 未知或空 hash 回落 `#/`；三 tab 与 hash
  双向同步；不新增 router 依赖——验证：`npm --prefix facet/web run build` 绿；本地目检深链、
  刷新、未知 hash 三态
- [x] 2.2 新增 `facet/web/src/SiteMark.tsx`（文本方章：单字/双字两态，CSS 方块、零图片），
  header 站点名旁挂单字「谦」——验证：本地目检 header 方章；产物无新增图片资源
- [x] 2.3 header 挂语言切换器（复用 `@/i18n/useLanguage` 的 `locales` / `changeLocale`，
  端名标签，持久化走既有 `platform.locale`）——验证：本地目检五语种切换即时生效、刷新保持

## 3. 介绍视图（机制版）

- [x] 3.1 新增 `facet/web/src/IntroView.tsx`：hero（千人千面 H1 / 副标 / 事实行 / 双 CTA）
  + 三特性卡（功能集里有什么 / 订阅与安装是两件事 / 版本快照）+ 路径图（文本图三行）
  + 快速开始（`npx @finddatatechonology/facet install <功能集 id 或含 id 的 URL>`，默认
  Claude Code；`--target cursor`、`--project <dir>`）+ 线页回链随 locale——验证：build 绿；
  本地目检 zh 与 en 两态，逐项对照提案锁定文案
- [x] 3.2 删除 `facet/web/src/IntroBand.tsx` 与挂载；市场页脚只留 `facet help` 指针——
  验证：仓内 grep 安装命令串出现次数 = 1（i18n 键与组件计一次）

## 4. 页脚（识律式）

- [x] 4.1 新增 `facet/web/src/LineLadder.tsx`：五行 = 双字方章 + 汉字数字（一/十/百/千/万）
  + 契约线名；谦面行标「当前站点」；整行可点 → 官网线页（随 locale）；非中文语种线名列用
  英文概念词——验证：本地目检五行、当前线标记、链接目标随语种；无图片请求
- [x] 4.2 新增 `facet/web/src/PageFooter.tsx`：品牌区（[谦面] + 标语）+ 联系块
  （`mailto:1253774197@qq.com`、`tel:+8617753221425`）+ LineLadder + 入口四项 + 使命句
  （整行文本、允许折行、不缩字号）+ 版权行与两条备案（ICP → beian.miit.gov.cn；
  公网安备 → beian.mps.gov.cn 查询页）——三视图常驻——验证：本地目检三视图页脚一致；
  375px 窄屏无横向溢出；两条备案链接目标正确

## 5. 验收与部署

- [x] 5.1 本地全量验收：`npm --prefix facet/web run build` 绿 + `node scripts/check-locales.js`
  绿 + 浏览器实机走查（落地即介绍 / 三 hash 深链与刷新 / hero 带已移除而 CLI 单源 / 页脚全项 /
  header 方章与五语种切换 / 非中文语种线名英文概念名 / 窄屏；证据截图落
  `gui-test-screenshots/`）
- [x] 5.2 部署验收：commit → GHA 镜像绿 → tcr-relay 回灌 → GitOps `platform.yaml` **与**
  `facet.yaml` 两清单同滚（仅滚 platform 不更新谦面域供页者）→ ArgoCD hard refresh →
  rollout 成功 → 探针：facet 域新 bundle 含介绍视图关键词、阶梯字符与使命句，壳 title 不变

## 6. 顺带修复（实机验收暴露）

- [x] 6.1 header 在 375px 窄屏横向溢出（新增方章与切换器后挤压）：header 与左侧组加 `flex-wrap`
  ——验证：375px 实机 `documentElement.scrollWidth = 375`（EN/ZH 两态）
- [x] 6.2 壳内登录按钮缺 i18n 键（`auth.login` / `auth.logout` 五语种皆无，英西法日页面一直
  显示中文「登录」——既有缺陷，本 change 局部化壳后显形）：补 `auth.*` 键 ×5 语种，App.tsx
  去掉内联中文兜底——验证：EN 实机按钮文案 Sign in；`check-locales` parity 909 键全绿
- [x] 6.3 快速开始内联 help 命令在窄屏折行断词：`<code>` 加 `whitespace-nowrap`
