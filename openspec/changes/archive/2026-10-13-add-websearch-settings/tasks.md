# Tasks: add-websearch-settings

## 1. 后端：解析层 + 路由（lib/ · server/routes/misc.js · dsh-profile.js）

- [x] 1.1 `lib/websearch-relay.js`：`resolveWebsearchRelay()`（stored→env→null）+ `maskToken()`（尾 4 位掩码，不泄露长度以外信息）
- [x] 1.2 `GET /api/config/websearch`：admin 门（requireMcpManage 同款）+ 返回 url/hasToken/tokenHint/source，**绝不含令牌明文**
- [x] 1.3 `PUT /api/config/websearch`：字段缺失=不动、空串=清除（回退 env）、非空=落 `deployment_config`；保存后调 `ctx.dshUpdateMcp()` 热重写 patch；日志不含值
- [x] 1.4 `POST /api/config/websearch/test`：服务端代发 `{url?,token?}`（缺省=生效值）到 `<url>/v1/search`，5s 超时，分类 ok/auth-rejected/upstream-degraded/unreachable/invalid-url；不落盘
- [x] 1.5 `dsh-profile.js` envRefs 解析点接入 stored 覆盖：`scopedEnv ?? storedRelay ?? process.env`（派生优先级不变）

## 2. 前端：设置分区 + 表单修复（web/src/）

- [x] 2.1 `web/src/lib/websearch-api.ts`：GET/PUT/test 三个薄封装（overlay-api 同款风格）
- [x] 2.2 `WebSearchSection.tsx`：url 输入 + token 输入（占位显示掩码、留空=不动、清除按钮）+ 保存/测试按钮 + 结果分类渲染 + "来源：部署环境变量/已保存/未配置"徽标 + 未配置时引导文案
- [x] 2.3 `sections.ts` 注册 `websearch`（Capabilities 组、adminOnly、Globe 图标、`/settings/websearch` 可寻址）
- [x] 2.4 `McpServerForm.tsx`：编辑态保存以原 config 为基底 merge（envRefs 等未建模字段保留）；websearch 行渲染"接线在设置→网络搜索"指引
- [x] 2.5 五语 locale：`settings.sections.websearch` + `settings.websearch.*` 全套（en/zh-CN/es/fr/ja），`npm run check:locales` 过

## 3. 测试

- [x] 3.1 单测（`scripts/test-websearch-settings.mjs`）：解析优先级（stored>env>null）、掩码不回明文、PUT 三态（缺/空/值）、测试端点分类（200/401/503/超时 stub）、dsh-profile 集成（stored 令牌进 patch、scoped master 在场时仍派生）
- [x] 3.2 `npm run test:unit` 全量零回归 + `npm run check:locales` + web 构建

## 4. 上线与验收

- [x] 4.1 出片（scs001 绕行线）→ ccr 落地 → GitOps 滚 platform/platform-demo
- [x] 4.2 生产实证：设置面板保存 url/token → patch 重写含新值（scoped 在场时派生值不变）；测试按钮分类正确（503 上游干涸如实标注）；清除回退 env；非管理员 403
- [ ] 4.3 归档（validate + archive + 记忆）
