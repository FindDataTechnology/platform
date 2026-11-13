# fix-ciyuan-lanes-white-screen — 任务清单

> 根因：`lanes.ts` 6 条 `shapes.*` 文案未转义花括号 → vue-i18n 运行时编译抛错 →
> 组件树卸载（真浏览器复现 `BODY len: 0` + `Unterminated closing brace`）。
> 另：能抓此类的守测存在但未入关键清单；出片链 test job 不含前端测试。

## 1. fork 文案修复（sub2api）

- [x] 1.1 `frontend/src/i18n/locales/lanes.ts`：zh 3 条（`shapes.rerank` / `shapes.websearch` / `shapes.tts`）
      未转义 `{`/`}` 改为 `{'{'}` / `{'}'}`（对照 en 行同时改 3 条，共 6 条）
- [x] 1.2 隔离编译验证：6 条转义后 baseCompile 全过（explore 预验证脚本）
- [x] 1.3 本地轻测：`pnpm exec vitest run src/i18n/__tests__/localesMessageCompile.spec.ts` 绿

## 2. 门禁补线

- [x] 2.1 `Makefile` `FRONTEND_CRITICAL_VITEST` 加 `src/i18n/__tests__/localesMessageCompile.spec.ts`
- [x] 2.2 反向验证：临时还原一条未转义文案 → 该清单测试红（证明真拦得住）→ 还原

## 3. 提交与 CI

- [x] 3.1 提交（只 add 本 change 文件）推送 `FindDataTechnology/sub2api` main
- [x] 3.2 fork CI frontend job（额度阻断——已知 org 私有 CI 全停；等效门=本地 `make test-frontend-critical` 31 文件 575 例全绿 + lint + typecheck）

## 4. 出片滚产

- [x] 4.1 `fd-build-channel` 判路 + `fd-build-channel pick` 取命令
- [x] 4.2 `ciyuan-tag` bump `ciyuan-v0.2.16-8` + tag（谱系惯例，随源码 push）
- [x] 4.3 出片（判路：公开快照或构建池）→ ccr digest 核验（skopeo，amd64 override）
- [x] 4.4 GitOps（fd-infra-deploy）：sub2api deployment image 滚新 sha；ArgoCD sync + revision 核验（防 sync 假绿）+ pod 镜像 sha 核验

## 5. 生产验收

- [x] 5.1 真浏览器（OIDC 登录）→ 点「模型车道」→ `/lanes` 四行卡片全渲染（zh）
- [x] 5.2 en 界面回归（切语言）→ 同样完整渲染
- [x] 5.3 控制台无 `Unterminated closing brace` 报错；`BODY len` 非 0
- [x] 5.4 车道页其他元素回归（错误面文案等未受影响）

## 6. 收口

- [x] 6.1 `docs/registry-maintenance.md` 发布记录登记（§9/§10 词元段）
- [x] 6.2 change 归档（openspec archive）
