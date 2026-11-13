# polish-zhiyu-embed-csp-and-site-seats

## Why

两笔登记在案的遗留账，都小而实在：

- **O1（P2，安全面）**：`GET /zhiyu/embed/:token` 的动态 CSP 把白名单里的每个域名同时发成 `https://host` 与 `http://host` 两个 `frame-ancestors` 源（`gateway/zhiyu/index.js:1107`）。2026-11-07 走查登记为「允许 http 源」：商家若在 http 站上嵌 iframe，浏览器侧会放行——嵌入面是接待台 2.0 的访客入口，明文页嵌管护壳与全程 https 的产品承诺相抵。widget 令牌 cookie 本身已是 `Secure`，唯独 CSP 这一环留了明文口。
- **O6（官网事实面）**：营销站活演示写「两张服务智能体席位：产品向导与壹座专家；本轮只放一张席位开口」。生产 demo 房实有 **4 个 agent 席**（产品向导、壹座专家、识律专家、柏讯专家，`/zhiyu/widget/meta` 实测），且 11-07 起 4 席均已能真答。官网是唯一对外承诺面，「以上全部在产」的诚实纪律要求文案与生产一致。

## What Changes

- embed 壳的 `frame-ancestors` 收紧为仅 `https://` 源：白名单条目一律产出 `https://host`（通配条目产出 `https://*.host`），**不再**附发 `http://host`。对已上线商家的影响：目前全部在用白名单均为 https 站（`zhiyu.finddatatech.cloud` / `platform.finddatatech.cloud`），行为不变；http 站嵌入从「能嵌」变「浏览器拒绝渲染」，属安全收紧而非破坏——如未来确有 http 商家，走显式加回的决策，不做静默兼容。
- 官网 `site-zhiyu/index.html` 活演示段文案与生产对齐：席位如实写四席（点名列出），删去「本轮只放一张席位开口」这句已失效的行为描述，保留「车道不通时如实报错」的诚实纪律句。
- 同步 `docs/zhiyu-site-source-bundle.md` 中该段镜像副本（站点源码的文档镜像，双份漂移是既有教训）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `zhiyu-widget`：嵌入壳 CSP 的 `frame-ancestors` 源收敛为仅 https——「白名单内嵌入成功加载」场景补一条 http 源被拒的反向场景。

## Impact

- 代码：`gateway/zhiyu/index.js` embed 路由一行（flatMap 源构造）。
- 静态站：`site-zhiyu/index.html` 一段文案；`docs/zhiyu-site-source-bundle.md` 同步。
- 测试：`scripts/test-zhiyu-widget.mjs` 补断言（CSP 不含 `http://`）；site-zhiyu 无测试，改后浏览器眼过一遍六章节渲染无回归。
- 不改 `hostAllowed`（meta/loader 的 host 闸与嵌入壳 CSP 是两条闸，本次只动后者）；不动令牌/cookie 安全属性。
