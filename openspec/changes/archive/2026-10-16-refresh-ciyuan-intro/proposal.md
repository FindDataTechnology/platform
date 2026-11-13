## Why

萬星·词元（FindDataRouter）的面板首页介绍停留在 2026-10-05，而词元在 10-14 从「命名
挂账」变成真产品（ADR-0024 谱系 fork + 三车道 v1 + 车道池 v1.1），面板自报版本已
`ciyuan-v0.2.16-6`。现状差距：

- **三车道零提及**：首页全文搜「车道 / 语音 / rerank / 重排」= 0 次，而面板 `/lanes`
  页（端点表/协议/计量/错误面/curl 示例）已上线在产。
- **品牌名缺位**：首页只写 `FindDataRouter` +「寻数 AI 服务网关 · 萬星第一颗星」，
  「萬星·词元」这一产品名（ADR-0024、`agents.json`、官网口径）在首页不存在。
- **快速上手只教 chat**：示例只有 `/v1/models`、`/v1/chat/completions`、`/v1/messages`
  与 A2A，车道能力（`/v1/rerank`、`/v1/search`、`/v1/audio/*`）没有入口。

同时有一个**结构性缺口**：首页 HTML 只活在词元 DB 的 `home_content` 设置里（23901
字符，2026-10-05 写入），paas / fd-infra-deploy / sub2api 三仓都搜不到源码——每次改
首页都是手改数据库，无版本、无评审、无回滚锚。

官网 `finddatarouter.md`（zh/en app 页）同样落后：只讲「按用户发放 token / 多渠道
故障转移」，车道与词元品牌都没有。

## What Changes

- **单一事实源落地**：首页 HTML 迁入 paas 仓（`docs/ciyuan/home-content.html`），配
  灌入脚本（admin API 部分 PUT，只写 `home_content` 键），改首页从「手改 DB」变为
  「改文件 + 跑脚本」。
- **首页重写**：品牌改为「萬星·词元」；新增**模型车道**段（三车道端点/协议/计量口径
  与面板 `/lanes` 同源）；快速上手补车道 curl 示例；保留五条产品线叙事与计费支持段。
- **官网 app 页更新**（fd-official-web）：`finddatarouter.md`（zh/en）补词元品牌与
  三车道能力，tagline 与正文与首页口径对齐。

## Capabilities

### New Capabilities

- `ciyuan-product-surface`: 词元的对外产品面——面板首页与官网 app 页 SHALL 呈现当前
  产品能力（含三车道），且首页内容 SHALL 有仓内单一事实源与可复现的灌入通道。

### Modified Capabilities

（无）

## Impact

- 数据：词元 DB 设置 `home_content`（经 admin API 写入，可回滚到基线副本）。
- 文件：paas 新增 `docs/ciyuan/home-content.html` + `scripts/apply-ciyuan-home.mjs`；
  fd-official-web 改 `src/content/apps/{zh,en}/finddatarouter.md`（需出片滚官网）。
- 无 API/契约变化；面板功能面不变（只改首页展示内容）。
