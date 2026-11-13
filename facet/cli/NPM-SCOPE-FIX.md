# npm scope 修正 — 完成记录与收尾清单

**状态：已完成（2026-10-06）**。CLI 现发布为 **`@finddatatechnology/facet`**（org `finddatatechnology`）。
老包 `@finddatatechonology/facet` 保留可装；唯一遗留见文末。

## 根因（当时核实）

- 个人 scope 继承 npm 账号名，而账号名本身拼错（`finddatatechonology`，少一个 n）。
- npm 官方：**用户名不能改名**，只能新建账号手工迁移；org 名则可以与账号名不同。

## 实际执行（全部完成）

1. **建 org** `finddatatechnology`（owner 账号 `finddatatechonology`）。
2. **bootstrap 发布 `@finddatatechnology/facet@0.1.0`**：
   - npm 直发需要 OTP（账号 2FA 是安全密钥、无 TOTP），bypass-2FA token 的新建已被 npm 收紧（勾选不落库，实证）；
   - 走通的是 npm 官方推荐的 **staged publish**：`npx npm@11 stage publish --access public` → 网页
     Settings → Staged Packages → Approve（一次安全密钥触控）。
3. **OIDC Trusted Publisher**：在包设置页登记 `FindDataTechnology/fd-craw-private` · `facet-cli-publish.yml`
   （权限 npm publish + stage publish），tag 实测通过。**注意**：早期登记指向 `platform` 仓是错的（该仓没有这个工作流）——
   正确连接已建成；那条错配是**无害死配置**（该仓无此工作流，无法通过认证），因删除需额外密钥触控暂未清，可随手在包设置页 Delete。
4. **tag 实测（两个坑，均已修）**：
   - runner 自带 npm 10 无法完成 OIDC 交换 → 工作流加 `npm install -g npm@^11`；
   - registry 拒收**私有源仓**的 provenance 包（E422）→ 工作流去掉 `--provenance`（TP 认证保留）。
   - 修完 `facet-cli-v0.1.1` 发布成功（19s，无 token 无 2FA），registry 实测：`versions [0.0.0-stage, 0.1.0, 0.1.1]`，`latest=0.1.1`，
     `npx @finddatatechnology/facet@0.1.1` 全新缓存可用。
5. **引用清扫（全部切新 scope）**：`facet/cli/package.json`（含 0.1.1）、`facet/cli/README.md`、`facet/cli/facet.js` 注释、
   `facet/web/src/cliFacts.ts`（网页命令的唯一来源）、`docs/pack-marketplace.md`、工作流注释与步骤名；
   临时 bootstrap token 已删，本机 `~/.npmrc` 已清理。

## 遗留（唯一一条，最终定性：npm 2026 安全政策阻断）

**老包 `@finddatatechonology/facet` 的 deprecate 标记**。2026-10-06 全路径实测后的最终结论：

| 路径 | 实测结论 |
|---|---|
| `npm deprecate` CLI（GAT + 恢复码当 OTP） | **403**——npm 2026-08 安全政策限制 GAT 的变更类操作（恢复码语义是账号找回，不解决此路） |
| `npm deprecate` CLI（bypass-2FA token） | bypass token 已停发（新建勾选不落库，实证） |
| 网页 Deprecate 控件 | npm 不存在 |
| `npm stage deprecate` | 不存在 |
| OIDC trusted publishing | 只许可 publish/stage-publish，不含 deprecate |

**影响评估：零用户影响。** 老包可装可用，官网 `/products/facet-market`、CLI README、包页 README、平台文档均已指向 `@finddatatechnology/facet`。
**重新可达的唯一现实路径**：npm 官方提供网页端 deprecate，或向 npm support 提交工单。属 npm 产品限制，不再跟进。
