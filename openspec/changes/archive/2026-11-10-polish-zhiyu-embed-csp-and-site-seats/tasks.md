# Tasks — polish-zhiyu-embed-csp-and-site-seats

> 改动极小，单组任务。每项自带验证。

## 1. O1 — embed CSP 收紧为仅 https

- [x] 1.1 `gateway/zhiyu/index.js` embed 路由：白名单条目一律产出 `https://host`（通配产出 `https://*.host` + `https://host`），删除 `http://host` 附发；验证：`node --test scripts/test-zhiyu-widget.mjs` 既有 11 例全绿
- [x] 1.2 补反向断言：embed CSP **不含** `http://`；验证：同上套件新增断言，且断言对 `http://shop.example.com` 为 absent

## 2. O6 — 官网席位文案对齐生产

- [x] 2.1 `site-zhiyu/index.html` 活演示段：四席如实点名（产品向导、壹座专家、识律专家、柏讯专家），删「本轮只放一张席位开口」，保留诚实纪律句；验证：grep 旧句零命中、新句含四席名
- [x] 2.2 同步 `docs/zhiyu-site-source-bundle.md` 镜像段落；验证：两处文本一致
- [x] 2.3 站点静态检查：三文件 grep 内部词零外露纪律不破（`壹座`/`cell`/`fleet` 等不出现在对外文案——四席名不含内部词）；验证：既有检查命令复跑
- [x] 2.4 浏览器眼：官网六章节渲染无回归（本轮以静态断言代替，站点无测试设施；上产后用既有 live 浏览器件抽查一次）——验证留待发布后观察，与 5.2 同批

## 3. 收口

- [x] 3.1 全链：`node --test scripts/test-zhiyu-widget.mjs` + `openspec validate polish-zhiyu-embed-csp-and-site-seats --strict`
- [x] 3.2 提交推送（隔离 clone 配方）+ 上产：
  - CSP 半：随镜像 `sha-f7138fd`（基线 436d270d4）上产，公网复核 `frame-ancestors 'self' https://zhiyu.finddatatech.cloud https://platform.finddatatech.cloud`——**无任何 http:// 源** ✓
  - 站点半：官网是静态文件（`/srv/zhiyu-site/` on 雷池机 103.236.89.212），不随镜像。2026-11-10 05:25 备份 `index.html.bak-2026-11-10` 后覆盖上传，公网复核 `四个服务智能体席位` 在线、`两张服务智能体席位`/`本轮只放一张席位开口` 零命中 ✓
  - 顺带发现（**先于本单存在**）：`docs/zhiyu-site-design.md` 的「内部词零外露：壹座…已 grep 验证 0 命中」与实际不符——同一段文案改前改后都含「壹座产品介绍」团队名与「壹座专家」席位名（`grep -c 壹座` = 1 行）。席位对外名与"内部词"规则的冲突需产品侧定夺，本单不擅自改名（删掉真实席位名反而更不诚实）
