# refresh-ciyuan-intro — design

## Context

首页渲染路径：sub2api 面板 `HomeView.vue` 读公开设置 `home_content`；若非空且不是 URL，
则以 `v-html` 整页渲染（管理员设置，XSS 风险由上游接受）。因此首页 = DB 里的一段
自包含 HTML（内联 `<style>` + 内联 `<svg>`），无外部依赖。

现状内容（23901 字符，2026-10-05 写入）已有完整设计语言：深色观测台风格
（`#060a16` 底 / `#38e1c8` 青 / `#7fd4ff` 蓝）、星座图 hero、五条产品线 legend、
快速上手 + 终端块、Agent 服务/计费双栏、备案页脚。本次重写**沿用同一设计语言**，
只增补能力与品牌，不推翻视觉。

## Goals / Non-Goals

**Goals:**
- 首页如实呈现当前产品面：词元品牌 + 三车道（语音/重排/搜索）+ chat 兼容。
- 首页内容有仓内单一事实源（可评审、可 diff、可回滚），灌入可复现。
- 官网 app 页与首页口径对齐。

**Non-Goals:**
- 不改面板功能面（`/lanes` 页、导航、i18n 均不动）。
- 不改五条产品线叙事结构（一十百千万）、不改计费/支持/备案信息。
- 不在首页暴露价目数字（价目在管理端配置，随分组变化——首页只讲计量口径）。

## Decisions

### D1 单一事实源：`docs/ciyuan/home-content.html` + 灌入脚本

- 权威副本进 paas 仓；脚本 `scripts/apply-ciyuan-home.mjs` 读文件 → admin API
  部分 PUT（只发 `home_content` 一个键，靠上游 `omittedSettingKeys` 机制保其余
  设置不被重置——已实证）。
- 基线副本另存（`docs/ciyuan/home-content.baseline-2026-10-05.html`）作为回滚锚。
- 备选否决：①「继续手改 DB」——无版本无回滚，且并发会话易互相覆盖；②「改成
  iframe 指向官网页」——首页要能在无外网/私有化部署下独立渲染，且面板与官网受众
  不同（面板用户已注册，官网是获客）。

### D2 内容结构（在原结构上增补）

保持原七段骨架，改动集中在三处：

1. **hero**：副标题加入词元品牌与车道能力一句话（「萬星·词元」+ 语音/重排/搜索）。
2. **新增「模型车道」段**（在快速上手之后）：三车道四端点表（rerank / search /
   audio ASR / audio TTS）+ 计量口径 + 一段 curl。口径与 `/lanes` 页 i18n 同源，
   避免两处漂移。
3. **快速上手**：保留 chat 三例，加车道示例指向 `/lanes` 页（面板内可达，不必在
   首页堆全部 curl）。

### D3 官网 app 页口径

`finddatarouter.md`（zh/en）在既有三小节（一个入口/按用户发放/故障转移）之后加
「模型车道」小节，并更新 frontmatter `tagline` 与 `kind`；保留 `demoUrl` 指向
`router.finddatatech.cloud`。

## Risks / Trade-offs

- **DB 与文件漂移**：若有人绕过脚本直接改 DB，文件即失真。缓解：脚本先回读当前值
  并打印摘要，且文档在文件头注明「权威副本在此，改请走脚本」。
- **首页体量**：当前 23.9KB，新增约 3-4KB。单页内联渲染无性能问题（无外部请求）。
- **官网出片**：fd-official-web 改动需出片滚官网（公开仓线，成本为零）。

## Migration Plan

1. 基线副本入库 + 新首页文件入库 + 灌入脚本。
2. 脚本 dry-run 打印 diff 摘要 → 正式灌入 → 浏览器验首页渲染（含移动端宽度）。
3. 官网页改动 + 出片滚产。
4. 台账记录。

**回滚**：脚本支持 `--restore-baseline`（把基线文件灌回 DB）。
