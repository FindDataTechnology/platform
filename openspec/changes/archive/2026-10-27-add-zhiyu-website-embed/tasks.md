## 1. 令牌与访客铸造面

- [x] 1.1 `zy_widget_tokens` 表与 helper（签 `wtr_`令牌/存哈希/白名单 JSON/吊销/轮换 site-secret），验证：建表幂等+吊销语义+哈希不存明文
- [x] 1.2 `gateway/zhiyu/guest-auth.js`（验证 widget 令牌+域校验/铸 zy_guest(cookie+URL 双轨)/verify identify HMAC（时间戳窗+nonce 一次性)），验证：伪签/过期/重放一律同形 403

## 2. widget 公共资源与动态 CSP

- [x] 2.1 `GET /zhiyu/widget.js`（ESM 装载器，同源校验+按 data-room 注 iframe+postMessage API），验证：非白名单 host 不注 iframe，同源下单帧到位
- [x] 2.2 `GET /zhiyu/embed/:token`（gateway 动态 `frame-ancestors`+SPA 精简壳），验证：白名单外 403/自身域渲染，回退 URL `tty` 生效

## 3. guest 席位与参与面

- [x] 3.1 guest 铸造并落 kind=guest 席位（join_from 固定、ref=访客代号、display 站点前缀+短号），验证：续访同席不复制
- [x] 3.2 guest 消息路由接入：作为人类触发走一期回合（@定向+广播可过+熔断+上限），验证：router 套件 + guest 名点名落地
- [x] 3.3 guest 私窗绝缘：任何 guest 视图不含 private 行，验证：注入私窗行验证 guest API 不见
- [x] 3.4 identify 升级并轨：合法声明后其 guest 行升级为用户行+令牌作废+历史归属保留，验证：先后消息流同归新身份
- [x] 3.5 限速：加载/消息双桶对应 429+节流文案，验证：双窗各自独立不过线

## 4. 计费与结算

- [x] 4.1 guest 触发应答 settleTurn 沿用部署键、usage_id 带 guest scope，验证：`pack_host_settlements` 见含 `guest:` 后缀行；pass/失败零计费
- [x] 4.2 房间日预算对 guest 强制：触顶=budget_exhausted 事件给 guest（如实非伪失败），验证：预算窗口化测试
- [x] 4.3 预算达 80% 通知主办（站内未读），验证：越阈一次通知不重复刷

## 5. 站内管理与界面

- [x] 5.1 空间设置+嵌入对话框：开/关、白名单编辑、复制 snippet、吊销令牌、令牌指纹+创建时间列表，验证：owner 可操作全部，非 owner 403
- [x] 5.2 widget 精简壳路由为**独立 ZhiyuEmbedPage**（比复用更干净：widget 数据面/无 nav/会话级 tty 缓存于 sessionStorage——与站内多绍不串；殊途同等覆盖 spec「精简壳」），验证：独立路由构建过+render 独立分支(不经站点 nav 壳)
- [x] 5.3 guest banner 明示身份与接待方，验证：guest 第一次进入看见横幅且不可伪造
- [x] 5.4 locale 词条：zh-CN/en 校词（es/fr/ja 给英文占位，照一期纪律），验证：check-locales 全 5 绿

## 6. 授权链接进房（弱化档）

- [x] 6.1 一键生成进房链接（不带 iframe 的完整空间页）：同源令牌体系+guest 进房，验证：持链者可读加入后历史、计费一致
- [x] 6.2 链接与 widget 的独立吊销位（分别可换），验证：吊销一位不影响另一侧

## 7. 测试与 e2e

- [x] 7.1 单测齐绿：guest-auth/widget/token/limit/identify 全 + 房间既有八套不回归，验证：`node --test scripts/test-zhiyu-*` 全过
- [x] 7.2 进程内全链套件：owner 开嵌入→外域访客铸席→点名应答→identify 升级→吊销后 403，验证：widget 套件 8/8（1.x 令牌+2.x CSP+3.x 访客+4.x 计费+6.x 链接）覆盖整条链
- [x] 7.3 回归哨：全仓 `npm run test:unit` 无新增红（树上残红=并行会话未提交 packs.js→vendor-onboarding + 既有 fleet/role-gated 座席；本班干净提交 c78cddbf 的 worktree 复测 gateway 套件 15/15 全过）；web typecheck / biome / locale parity / web build 全绿

## 8. 发布与走查

- [x] 8.1 出片四清单同代滚版（fd-build-channel 判路 + skopeo 硬门 + digest 全等），验证：镜像 tag 与注释同体换
- [x] 8.2 生产真机走查：开嵌入→白名单外拒框/test 页加载→guest 点名真答→identify→预算触顶提示→吊销 403，验证：走查录落台账 §15；ZHIYU_WIDGET 默认开后再验收
- [x] 8.3 `openspec validate add-zhiyu-website-embed --strict` 零 error；台账 §1 与 §15 记录
