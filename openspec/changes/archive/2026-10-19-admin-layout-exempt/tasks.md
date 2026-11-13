# Tasks — admin-layout-exempt

## 1. 实现

- [x] 1.1 核心层 `packages/core/src/lib/surfaces.ts resolveLayout`：`facts.authOn===true && facts.isAdmin===true` 时丢弃 `layers.role`（放核心层而非 server/layout.js：它是解析规则，且与既有 adminOnly 谓词同一处判定）。验证：`node --test scripts/test-layout-resolution.mjs` 24/24 绿
- [x] 1.2 单测 `scripts/test-layout-resolution.mjs`：① admin + simple → 三容器全等于部署默认；② 同输入非 admin → simple 收窄（既有行为）；③ admin + 部署隐藏 `tasks` → 缺 `tasks` 其余全集；④ **auth off + 角色 → 仍收窄**（本地角色预览与 hermetic e2e 依赖它，与 adminOnly「auth off 不过滤」同一哲学但方向相反——admin 判定需要 auth on 的肯定答案）；⑤ 用户层调整对豁免 admin 仍生效。验证：24/24 绿、既有 19 条 storage 用例不变
- [x] 1.3 e2e：hermetic 为 auth off，按 1.2④ 不触发豁免，故不新增 e2e（既有 layout.spec 13 条角色收窄用例必须保持绿=回归守门）；admin 路径由单测 + 2.3 生产真机覆盖。验证：layout.spec 全绿

## 2. 本地门与发布

- [x] 2.1 `npm run test:unit` / `typecheck` / `lint` 绿；`web:build:e2e` 后 layout.spec 全绿。验证：退出码 0
- [x] 2.2 提交只 add 本变更文件，双推；公开快照线出片（**快照 `.github` 先手动修剪到只剩 image.yml**）→ relay OK → ccr digest → 双清单 → ArgoCD → 双 rollout 绿 → pod imageID 全等。验证：台账证据链
- [x] 2.3 生产验收：真 admin 账号临时 `PUT /api/roles/assignments/<admin> {primary:"stock"}` → `/api/config.resolvedLayout` nav 7 项、settings 13 节（含 models/roles/layout/channels/diagnostics/status/branding）→ 侧边栏眼见 → 恢复 `standard`。验证：脚本 ALL PASS 且角色已恢复
- [ ] 2.4 台账 §12.17（含 10-18 管理界面消失事故：根因两层、数据已清、规格变更）；核销；`openspec validate admin-layout-exempt --strict` 绿后归档 + 两份 spec 同步。验证：归档目录存在；主 spec role-system 场景改为「not narrowed」
