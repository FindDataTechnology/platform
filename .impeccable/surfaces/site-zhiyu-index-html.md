---
version: 1
slug: "site-zhiyu-index-html"
primary_target: "site-zhiyu/index.html"
related_targets: []
---

# Surface brief: 智语官网（site-zhiyu/）

Scope: single-page marketing site, pure static (index.html/style.css/script.js), no build, Chinese-first. Mode: Persuade.

Audience: (1) merchants who want an AI reception desk on their own site/WeCom group; (2) team operators who want humans and deployed agent teams in one shared room; (3) technical decision-makers evaluating a communication layer. Job: understand what 智语 is in one viewport, believe it is real (in-production evidence), act (go 万星 open a room; secondary: talk to the live room embedded on this page). Proof: in-production surfaces only — 站内空间 (一期 38/38 走查), 网站嵌入 guest 席 (二期 24/24), IM 群桥端到端 (三期, 企微真机往返), 事项串转人工 (生产实证), 值守/日预算/应答上限/熔断/披露边界. Constraints: 无发明价格/客户/benchmark; 不泄露内部拓扑/IP/k8s/库名; 壹座不出现在文案, 万星仅作 CTA 落点; 琥珀语义让给永忆; focus/selection 归本站炉橙. Family: ground #070c17 + ink #e9e2d2 + Noto Serif SC / IBM Plex Mono shared with 永忆; 本站主色 炉橙 #e0895f (人声/在场), 青 #4fd0d8 降为智能体/链接次色, IM 席青绿 #3aa6a0, 访客席雾 ink; 与永忆的 supersede 弧成对的是 值守弧 (hover 分身→亮起其主人).

## Direction contract

THESIS: 全页只有一张活桌——功能不是卡片目录,而是桌边的席位;镜头绕桌走,桌面永不消失。拒绝的类别默认: 首屏双栏+三段功能卡的「永忆镜像」排布。

OWN-WORLD: 深夜地 #070c17 上的手绘活桌俯视 SVG(细晕环席位点,非图标卡片);炉橙=人声光/发言亮环/主 CTA,青=值守席与链接,青绿=群桥门口,雾 ink=访客;暖白衬线标题、等宽坐标与时间戳;hairline 分带,无玻璃无渐变字。

STORY: 来访者在一屏内看懂「人和 agent 团队同桌说话」,相信三面(空间/嵌入/群桥)已在产,并被「值守有预算、问倒会转人工、这桌记得每次会议(永忆)」安住信任,主行动=去万星开一间房。

FIRST VIEWPORT: 全屏仅一张桌,居中,亮三席——暖席(主办)、青席带主人弧(值守分身)、半透明席(访客·A3F2);H1 小字压桌心投影,双 CTA 浮桌缘(主=去万星开一间房/次=先在这页聊一句);一条炉橙光沿桌边绕走=一次回合在跑。无第二层元素。

FORM: 绕桌镜头——滚动=相机绕固定桌心旋转,转到哪席,哪一面功能从该席展开(分身席→站内空间/访客席→网站嵌入/桌外门口→IM 群桥/转回桌心→×永忆+机制+活 DEMO);hover 分身席亮起主人弧=签名交互;prefers-reduced-motion 降级为静态桌面图+顺序可读章节。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Seed key: 7f389923 (surface/persuade; dealt 7/6/3; user locked 桌边三席).

Unresolved: 活 DEMO 区真房间 widget 令牌待运维签发(data-room 未注入时回落为标注「合成演示」的脚本回合)。
