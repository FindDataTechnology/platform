# 簇 G8b 体检卡：registry 面遗留 3 模块

审计日 2026-11-06。paas HEAD=187678074e1b（2026-11-06 05:07）。跨仓：registry fork=/Users/chengsishi/code/mcp-gateway-registry（HEAD d821e624，branch fd-product-home，2026-11-05 23:32）。部署态：platform:sha-a96731b←5e91d61b（`git merge-base --is-ancestor`=是，落后 12 commit）；mcp-registry@sha256:d47a644a←fbb5503a（fd-audit-rows-stamp ⊕ cherry-pick d821e624，fd-infra-deploy/mcp-registry/prod/registry.yaml:72）——即 fork 现势已上产。

---

## 1. registry-console-i18n — A
理由：i18n 契约逐条可指、门禁在 CI、三条中文冒烟即 e2e 用例本体，fork 现势已随 d821e624 上产。
① 对齐：探测/持久化/URL 覆盖→frontend/src/i18n/t.ts:40（zh*→zh）、:22（`registry.lang`）、:25+81（`?lang=` 覆盖并持久化）；`<html lang>`/标题→frontend/src/contexts/I18nContext.tsx:50,53；切换入口=LanguageSwitcher.tsx 用于 Login.tsx+Layout.tsx（grep 在册）；缺译回退源串=t.ts:1-9（静态打包字典，无运行时加载失败面）；覆盖门禁=frontend/scripts/i18n-scan.cjs:31,45,100（critical 文件清单）+:270（缺译率上限 5%），CI=.github/workflows/frontend-test.yml:69 `npm run i18n:scan -- --max-missing 5`；术语「注册处」=shell.zh.json:22-23,83；边界：字典仅覆盖客户面条目（与 spec 翻译覆盖边界一致）。
② 测试：t.test.ts+scan.test.ts（10-07）、I18nContext.test.tsx（10-15）、LanguageSwitcher.test.tsx（10-07）、e2e/i18n.spec.ts（10-14）:104 首屏/:119 登录页+切换持久化/:139 连接入口——恰为 spec 三条中文冒烟；上线探针（部署后探针断言）未见独立脚本=未证实。
③ 部署：fork d821e624 被 cherry-pick 进产线源 fbb5503a（registry.yaml:72 注释）；i18n 面代码最后改动 10-15，早于该源线。
④ 痛感：i18n 面 since 09-05 共 3 commit，fix 1（33%，量小）。
⑤ 陈旧：spec 2026-10-05 vs 代码（frontend/src/i18n/）2026-10-15 → 10 天，新鲜。

## 2. registry-market-deployment — C
理由：实现/测试健康，但 spec 中心需求（REGISTRY_URL 直喂目录）在生产已被 facet 投影取代且 36 天未回写，运行簿令牌注记过期。
① 对齐：桥读源→registry-bridge.js:28-33（REGISTRY_URL+MARKET_REGISTRY_TOKEN）；configTemplate→:224（`{REGISTRY_URL}/{name}/mcp`）；a2a agents→:421（`{REGISTRY_URL}/agent{path}/`）；manifest env→k8s/deployment.yaml:116-127（token 取 Secret key `market-registry-token`）；运行簿→DEPLOY.md:658-723（签发/patch/重启/验证全流程）。运行簿 :694 示例 patch 键为 `MARKET_REGISTRY_TOKEN` 而 manifest :127 读 `market-registry-token`——键名不一致=未证实生产 Secret 实际用哪个。
② 测试：scripts/test-registry-bridge.mjs mtime 2026-11-05（含 last-good 降级路径）；k8s/deployment.yaml 无对应 manifest 测试。
③ 部署：prod platform.yaml:483 `REGISTRY_URL: https://mcp.finddatatech.cloud` 在册；token 走 envFrom platform-secrets（platform.yaml:68-72），仓内不可见=存在性未证实。**但** platform.yaml:103-111 已设 `FACET_CATALOG_URL=http://10.43.71.119:3200`（W1 add-supply-catalog-unification 3.2/D4），registry-bridge.js:668-670 明示 REGISTRY_URL 直喂已废弃、仅作回退——spec「Deployed market reflects registry content」的直喂口径与现实脱节。
④ 痛感：registry-bridge.js since 09-05 共 15 commit，fix 4（27%）；DEPLOY.md 共 62 commit，fix 9（15%）。
⑤ 陈旧：spec 2026-10-01 vs registry-bridge.js 2026-11-06 00:29 → 36 天=**stale**；DEPLOY.md:681 令牌续期注记仍写「current one expires 2026-09-25」（已过期 6 周）。

## 3. registry-product-home — A
理由：spec/代码/测试同日定格（10-15），落地页四要素+公开摘要防泄漏逐条可指，部署面有专属 ConfigMap 且 fork HEAD 已上产。
① 对齐：根路径分流→registry/main.py:1584-1608（:1594 会话 cookie 判定，:1603 `Vary: Cookie` 防缓存串页；stale cookie 走 SPA 即既有行为，:1567-1569 注释明示）；落地页镜像解耦→main.py:1570-1573（`LANDING_ASSETS_DIR=/app/landing-assets` 覆盖、镜像内置基线）；四要素→registry/static_landing/index.html:65-66 价值主张/:71-86 三步（逛市场选 pack :75、订阅 :80、装进 :86）/:92 市场一览/:103 开发者发布入口/:6 品牌「壹座·Packs」；市场活数据→index.html:112 fetch `/api/public/summary`；公开摘要→registry/api/public_record_routes.py:235-236 端点、:206-216 public+enabled 过滤、:255-263 策展条目 fail-closed 复核（非 public 静默剔除）；控制台品牌→t.ts:28 `Yizuo Packs`+shell.zh.json:2→「壹座·Packs」。
② 测试：tests/unit/test_root_path_split.py（10 个 test，10-15）、tests/unit/api/test_public_summary.py（10-15）。
③ 部署：fd-infra-deploy/mcp-registry/prod/landing-config.yaml（ConfigMap）/registry.yaml:106-107 挂 `/app/public-featured`——**当前只含 featured.json 且为空 `[]`**（yaml 头注明「基线策略，策展由运营后续补」），无 index.html 覆盖键=落地页正文现由镜像基线呈现，「改文案不出镜像」需先补 ConfigMap 键+rollout restart（yaml 头已写明 subPath 不热更）。
④ 痛感：product-home 面（static_landing/public_record_routes/landing/test_root_path_split）since 09-05 共 3 commit，fix 1。
⑤ 陈旧：spec 2026-10-15 vs 代码 2026-10-15 → 0 天。

---

## 簇摘要（最严重三件）

1. **registry-market-deployment spec 与生产现实脱节 36 天（簇内唯一 stale）**：W1 已把目录读路径切到 facet 投影（platform.yaml:103-111、registry-bridge.js:668-670 直喂降级为回退），spec 的中心 Requirement 仍钉 REGISTRY_URL 直喂；随 W2 存储合并推进，此 spec 须回写否则按 spec 对账生产必得出错误结论。
2. **市场令牌链路生产态不可证且运行簿过期**：MARKET_REGISTRY_TOKEN 只在带外 Secret（platform.yaml:68-72 envFrom），仓内无法证实存在/有效；DEPLOY.md:681 续期注记停在 2026-09-25，而桥的缺 token 语义是静默回落 bundled catalog（registry-bridge.js:42）——真过期时目录内容无声降级，且 :694 示例键名与 manifest :127 读键不一致。
3. **落地页部署期资产名存实虚**：landing-config.yaml 只挂了空的 featured.json（无 index.html 覆盖键），「仅改文案不出镜像」当前要先补 ConfigMap 才成立；精选策展为空=落地页精选卡区悬置（计数仍活），与 spec 四要素之「来自公开摘要的市场内容」只达成一半（计数达成、精选未策展）。
