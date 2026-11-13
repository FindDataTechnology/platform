# Proposal: add-facet-intro-view

## Why

facet.finddatatech.cloud 落地即市场卡片墙：首访者不知道谦面是什么、能干什么、技能怎么进编辑器。
2026-10-05 的 `add-facet-intro-hero` 只上了 hero 带（一句定位 + 三个 quick facts），并把「谦面域
独立介绍路由/关于页」列为 non-goal（薄壳哲学）。本轮（2026-10-05 六轮 grill 定案）推翻该
non-goal：介绍视图作为默认落地，内容以**产品机制**为主体（用户要求「符合产品的本来特征」，
不写成产品线导览）；同时把谦面域页脚补齐到家族基准（识律页脚版式），首次落地五线阶梯的
文本型图示与公司使命句。

## What Changes

- **三视图 + hash 路由**：`#/`=介绍（默认落地）、`#/packs`=功能集市场、`#/mcp`=MCP 服务目录；
  不引 router 依赖（hashchange 监听，同萬星形态）；tab 与 hash 双向同步，无 hash 落 `#/`。
- **介绍视图（机制版，静态）**：
  1. hero：H1「千人千面 —— AI 编辑器的功能集与工具分发市场」；副标「功能集把技能、MCP 引用与
     Agent 人格打包上架——浏览、订阅、发布；一行命令装进 Claude Code / Cursor」；事实行「匿名可
     浏览，登录后可发布与订阅（与壹座同一套身份）」；双 CTA（浏览功能集 → `#/packs`；查看 MCP
     服务 → `#/mcp`）。
  2. 三特性卡：①功能集里有什么——技能原文、MCP 引用、Agent 人格，外加版本、标签与作者；详情页
     可读每个技能的全文与历史版本；②订阅与安装是两件事——订阅是在册（与壹座 Store 同册），安装
     有三条路径；③版本快照——安装取确定版本，重跑 `install` 即取新快照；CLI 不写 MCP 配置、
     不代持凭据（凭据在壹座内打通）。
  3. 路径图（文本图）：创作者 --发布--> 谦面市场 --订阅--> 壹座（一键安装到对话运行时，MCP 凭据
     已打通）；谦面市场 --CLI 安装--> Claude Code / Cursor 技能目录（技能快照落盘、MCP 引用照打）。
  4. 快速开始：`npx @finddatatechonology/facet install <功能集 id 或含 id 的 URL>`（默认 Claude
     Code；`--target cursor`、`--project <dir>` 可选）。
  5. 官网谦面线页回链（随 locale）。
- **hero 带退休**：删除 `IntroBand.tsx`，事实并入介绍视图；CLI 安装命令保持单源（市场页脚只留
  `facet help` 指针）。
- **页脚（识律式，三视图常驻）**：品牌区（双字方章「谦面」+「谦面 Facet」+ 标语「AI 编辑器的
  功能集与工具分发市场」）；联系块（`1253774197@qq.com` 做 mailto、`17753221425` 做 tel:+86，
  两站同款）；「寻数产品线」五线阶梯（双字方章 + **汉字数字列** 一/十/百/千/万 + 契约中文线名；
  谦面行标「当前站点」；整行可点 → 官网线页、随 locale）；入口列（功能集市场 / MCP 服务目录 /
  谦面线页 / `npx @finddatatechonology/facet help`）；使命句；版权行 + 两条备案。
- **公司使命句**（替换原拟的阶梯 wordplay 句，逐字）：「寻数科技聚焦AI时代下的文本和数据处理
  的基础设施建设，致力于推动信息平权，最终促进社会公平。」五语种 i18n：zh 逐字；en 源写作
  "FindData builds text- and data-processing infrastructure for the AI era, advancing equal
  access to information and, ultimately, social equity."；es/fr/ja 对译；页脚作整行文本、允许
  折行、不缩字号。
- **备案两行**：`粤ICP备2026118740号-1`（链 beian.miit.gov.cn）+ `粤公网安备44030002016558号`
  （链 beian.mps.gov.cn 查询页 `#/query/webSearch?code=44030002016558`）；纯文本链接，不挂
  警徽图片。
- **header**：站点名旁单字方章「谦」；语言切换器（五语种，复用 `web/src/i18n/useLanguage`，
  持久化 `platform.locale`）。
- **记号规则**：全部为文本方章、零图片——导航栏用单字（谦），页脚品牌区与阶梯行用双字
  （谦面/壹座/识律/柏讯/萬星）；方章汉字在所有语种保留，非中文语种的线名列用英文概念词
  （Base/Lex/Wire/Facet/Constellation）。
- **i18n**：全部新文案走 key，五语种全写（en 为源；`scripts/check-locales.js` 强制键集 parity）；
  `facetHero.*` 键组按介绍视图新结构迁移（旧键不留孤儿）。

## Capabilities

### New Capabilities

无——全部落在既有 `facet-platform` 能力内。

### Modified Capabilities

- `facet-platform`:
  - REMOVED「The facet web shell carries a product intro band」（带退役；reshape 走 REMOVED +
    ADDED 新名，不做场景级移除）；
  - ADDED「The facet web shell carries a product intro view」（机制版内容口径、静态、CLI 事实
    单源、线页回链随 locale、五语种）；
  - ADDED「Shell views are addressable hash routes」（`#/` / `#/packs` / `#/mcp` 可深链可刷新、
    tab 同步）；
  - ADDED「Site marks are text characters sized by placement」（导航单字、品牌区与阶梯行双字、
    零图片、汉字跨语种保留）；
  - ADDED「The shell footer carries the five-line ladder」（双字方章 + 汉字数字列 + 契约线名 +
    当前线标记 + 整行可点 → 官网线页随 locale）；
  - ADDED「The shell footer carries brand, contact, mission, and filing statements」（品牌区 /
    联系块 / 入口列 / 五语种使命句 / 版权与两条备案）；
  - ADDED「The shell header carries a locale switcher」（五语种、持久化、当前语言可见）。

## Non-goals

- 活数据（功能集计数 / 订阅数 / 服务计数）——介绍页与页脚不接统计，docs voice 纪律照旧；
- es/fr/ja 的叙事重写（key 全写，以中英为定稿源对译，不逐语种重写）；
- 官网改动（公安备案行由 fd-official-web 仓 `add-mps-filing` 另立）；官网 `/products` 页首
  与识律页脚的「壹座之上，萬星闪耀」是命名阶梯 wordplay（壹座=一、萬星=万），本轮不动；
- 萬星侧改动（fd-wanxing 仓 `upgrade-wanxing-footer` 另立）；柏讯 / 识律页脚反哺；
- `facet/web` 测试基建新建（仓内惯例：build + 浏览器实机验收）。

## Impact

- **Code**: `facet/web/src/App.tsx`（hash 路由 / 单字方章 / 切换器 / 页脚挂载 / 三 tab）、新增
  `facet/web/src/IntroView.tsx`、`PageFooter.tsx`、`LineLadder.tsx`、`SiteMark.tsx`；删除
  `facet/web/src/IntroBand.tsx`；`web/src/locales/{en,zh-CN,es,fr,ja}/common.json` 新增/迁移 key；
  复用 `@/components/packs/PackMarketView` 与 `McpCatalog` 零改动。
- **Pages**: `facet.finddatatech.cloud` 的 `#/`、`#/packs`、`#/mcp`。
- **部署**: 随 paas 主镜像线；`platform.yaml` 与 `facet.yaml` 两清单必须同滚（2026-10-05 已证
  仅滚 platform 不更新谦面域供页者）。
- **契约**: 五线名称与数字映射逐字取 `official-web-product-lines`（壹=1、识=10、柏=100、
  谦=1000、萬=10000，数字列写作汉字一/十/百/千/万）；两条备案号与官网一致；方章与阶梯为纯文本
  零图片。

## 验收口径

- `npm --prefix facet/web run build` 绿 + `node scripts/check-locales.js` 五语种 parity 绿；
- 浏览器实机：`#/` 落地即介绍；三 hash 可深链、刷新保持；hero 带已移除而 CLI 事实单源；页脚
  含方章 / 联系 / 阶梯（汉字数字列、当前站点、行可点）/ 入口 / 使命句 / 两条备案；header 单字
  方章与五语种切换器；非中文语种线名为英文概念词；375px 窄屏无横向溢出；
- 部署后探针：facet 域新 bundle 含介绍视图关键词、阶梯字符与使命句，壳 title 不变。