# Tasks — fix-zhiyu-embed-sender-attribution

## 1. 修复

- [x] 1.1 `ZhiyuEmbedPage.tsx` 的归属判据由「是 human 就行」改为「`senderMemberId === visit.memberId`」；`visit` 未就绪时一律不算「我」；验证：`npm --prefix web run typecheck` 绿 + 移动视口浏览器眼复验
- [x] 1.2 非本人人类消息显示真实署名（`sender.display`，guest 为「访客 · <域名>」），无 sender 时回退「访客」而非「接待」；验证：同上

## 2. 收口

- [x] 2.1 `openspec validate fix-zhiyu-embed-sender-attribution --strict`；验证：绿
- [x] 2.2 提交 + 隔离 clone 推送；验证：fetch 后远端 tip 的内容含新判据
- [x] 2.3 上产后的移动视口浏览器眼（390×844 打开公开演示房 embed）：另一访客 2026-11-07 的问题现在渲染为**「访客 · zhiyu.finddatatech.cloud」左侧灰色气泡**（改前是「我」+ 右侧主色）；四席欢迎行、输入区、无 console 错误同时复验通过。上产镜像链：`sha-45dd8b8`（我剪的片）→ 被并发会话随后滚到 `sha-cdd6237`，两个镜像的 `ZhiyuEmbedPage-*.js` 均含 `e.senderMemberId===E` 判据（从镜像层实测）

## 实施记录

- 判据：`const mine = Boolean(myMemberId) && row.kind === "human" && row.senderMemberId === myMemberId;`
- 署名：本人「我」；他人 `sender.display`（facade 带「代 X 出席」）；无 sender 的 guest 行标「访客」。
- 发现路径：移动视口浏览器眼截图（curl 与站内页测试都看不出——站内房间页本来就是按 id 比对的）。
