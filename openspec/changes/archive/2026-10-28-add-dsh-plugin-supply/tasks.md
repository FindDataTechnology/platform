# 任务：add-dsh-plugin-supply

## 1. 机制实证与桥接层

- [x] 1.1 实证 HMR watcher 覆盖面：改 profile `cordis.patch.yml` 是否触发 live recompose（改读 `readProfilePatches` → 它包含 `...context.overlays`，热重组会重建完整层序（含平台 `--patch` flag 层），因此服务 reload 的热重组对平台叠加层安全）；实证 `pluginManager` 服务方法面（`listBundles`/`setBundleEnabled`/`setPluginEnabled`/`reload`，`change()` 把失败吸收成 `{application:"failed",error}` 而非抛出）；结果注释进 `dsh-profile.js` 生成器与桥头注
- [x] 1.2 新增 `dsh-profile-template/platform-plugin-supply-bridge.js`：子类 `UserQuestionsSdkServer`（链尾追加），`plugins/list` → 服务清单投影（id/描述/enabled/相位/错误元数据），`plugins/set_enabled` → 服务 bundle-toggle 写语义入 profile 清单；失败/拒绝转 JSON-RPC 错误；`dsh-profile.js` 新增 `writePluginSupplyPatch()` 生成 `plugin-supply.patch.yml`（disable `platform-user-questions-server` + insert 新行）；`dsh-bridge.js` 的 `patchArgs`/`#patchPaths`/构造器接线 + `listPluginBundles`/`setPluginBundleEnabled` 两个 RPC 方法
- [x] 1.3 合同扩展：`scripts/lib/dsh-contracts/contracts.mjs` 新增 ⑱ plugin-supply（清单形状 + 未知名拒绝 + 样例 bundle 持久化往返 off→on + 组合存活），runner 组合 `writePluginSupplyPatch`；**18/18 PASS**（原 17 条零回归）

## 2. 服务端与传输

- [x] 2.1 传输选型落地为 WS（与 set_model/set_permission 同族；权限切换已是 WS-only，无 REST 先例需要复制）：`server/ws.js` 新增 `list_plugins` / `set_plugin_enabled` 两个 case；`server/agent-session.js` 新增 `getPluginBundles()` / `togglePluginBundle()`（isStreaming 守卫 + `application:"restart-required"` 时走 `dshBridge.restart({})` + 重启后重读清单）
- [x] 2.2 `togglePluginBundle` 应用完成后广播 `plugins_changed`（携带新 roster）；前端据此清 pending 态
- [x] 2.3 口径核对：本能力**无新增 env 旋钮**（无运行时安装、无外部端点）；REST/WS 鉴权口径与既有控制面一致（cell 内天然单用户，CLOUD_MODE/forward_auth 不改）；`.env.example` 无需新增项，DEPLOY.md 已写明

## 3. Web UI：Settings「插件」区块

- [x] 3.1 `/settings/plugins`（`web/src/components/settings/PluginsSection.tsx`）：清单（包名/版本/描述/保护徽标/错误原因）+ 开关 + applying 态 + 失败行禁使能 + 「由部署供给，不可安装」提示条
- [x] 3.2 Settings 导航第三区块：`sections.ts` 注册 + **`packages/core/src/lib/surfaces.ts` 的 `SETTINGS_SURFACES` 注册**（导航由服务端 `resolvedLayout.settings` 白名单驱动，漏一处则深链回落 general——实测踩中并修复）；i18n 五语言（zh-CN/en/es/fr/ja，check:locales 通过）；错误元数据展开呈现
- [x] 3.3 流式中开关置灰 + 提示（`isStreaming` 客户端态），服务端同守卫

## 4. 白名单供给链与打样

- [x] 4.1 打样 bundle `dsh-matrix/samples/supply-probe-bundle`（惰性 cordis 插件 + `dsh.bundle` 声明）：`dsh-matrix` manifest+lock 增量（`file:` dep）、`prune.json` 复核（不匹配任何剪枝模式）、`dsh-profile-template/package.json` **双处声明**（`dependencies` 保行 + `dsh.profile.bundles` 保层序——只声明后者会在 disable 后从 roster 消失、无法回升，实测踩中并修复）；镜像 `COPY dsh-matrix/samples` + `npm ci` 前拷贝到 `/opt/dsh/samples`；桌面 predist staging 拷贝 samples + 平铺时解引用（file: 依赖是 staging 内软链）
- [x] 4.2 `linkProfilePinnedModules` 扩链：`declaredWhitelistBundles()` 从 template 读白名单并加入钉链集合（桌面/真目录布局）；image 布局因整树单软链天然覆盖；cell/dump 组合实证由合同 ⑱ 的新鲜临时 home（mkdtemp + 同一套生成器 + npm ci 出货形状）承担
- [x] 4.3 部署文档：DEPLOY.md 新增「dsh plugin supply（whitelisted bundles）」节（白名单三步、供应链审查点=烘焙期构建脚本、运行时语义、传输面）；CLAUDE.md 新增能力段

## 5. 验证与收口

- [x] 5.1 e2e：`e2e/plugins-supply.spec.js` 4/4 绿（roster 保护/失败呈现、toggle applying→plugins_changed 落地、流式置灰、空清单）；踩坑=section 自身 `list_plugins` 的真 roster 晚到会覆盖注入态，已加「等首次真回答再注入」
- [x] 5.2 服务端真机冒烟（本地）：roster 11 项、样例 on→off→on 两次 `plugins_changed`（application=applied，HMR 热重组零重启）、dsh-base 拒绝（`management-required`）
- [x] 5.3 滚产走查（sha-bbf73ea，2026-10-28）：生产 UI 真机——Settings→Plugins 区块在位（CAPABILITIES 组）、9 条 roster、`dsh-base` 保护置灰、供给提示条（截图 /tmp/wt-plugins-roster.png）；in-pod `wrote plugin supply bridge patch` 实证；**已补验（2026-10-28 晚，台账 §15.70 续2）**：跨 cell 隔离 —— 双隔离实例 A/B（真实 server+桥+服务）：A 关掉样包 → A manifest 变 `[dsh-base]`、**B 名单仍 `enabled=true`、B manifest 未动**、**共享 module 树指纹前后一致**（`5042a1c9…`），A 事后复原；生产旁证＝同 pod 内 7 个 cell 目录各持独立 DSH home/patch。**仍欠**：样包行只在新 cell/桌面出现（既有 cell 的 scaffold 不覆写，按设计）
- [x] 5.4 CLAUDE.md 能力段 + 合同 18/18 记录（供 `port-dsh-0.2.1` 引用）；台账 `registry-maintenance` 条目随发布 commit 补记