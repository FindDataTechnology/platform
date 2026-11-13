# 开源发布 runbook（私仓专用，不入公开快照）

把本仓（fd-craw-private，寻数·壹座 Base 线）以**无历史快照**方式发布为公开仓库的完整流程。
快照由 `scripts/make-public-snapshot.mjs` 生成：git archive 导出 → 覆盖公开文档 → 删除内部文件 → 清洗内网引用 → 三重验证（结构断言 + 禁忌模式扫描 + gitleaks）。

> 本文件自身在快照的排除表里（`EXCLUDE_PATHS`），永不进入公开仓。

## 0. 背景与决策（2026-10-01 定）

- **发布方式：无历史快照**。git 全历史 gitleaks 扫描命中 3 处真实密钥（见 §1），且 DEPLOY.md/openspec 归档等内部运维细节遍布历史——带历史公开需 filter-repo 清洗 + 强推，收益低风险高。私仓历史不出门。
- **许可证：MIT**（用户 2026-10-01 拍板），LICENSE 已在仓根，README 双语 License 段已就位。
- **门面**：遵循 finddata 工作区 five-lines-public-surface 规范——README.md（英主）+ README.zh-CN.md（中）互链、顶部壹座 Base 线横幅链 `www.finddatatech.cloud/products/base`（快照脚本有断言）。

## 1. 前置：历史泄露的 3 把 key —— 已确认失效（2026-10-01 用户确认）

gitleaks 于 2026-10-01 在私仓历史中确认过 3 处真实密钥（当前树均已净化，仅历史对象残留）：

| Key | 泄露位置（commit） | 状态 |
|---|---|---|
| VOLCES_PLAN_KEY_1 值 ×2 | `f9ead4e8`（2026-07-25）electron/config/settings.js + local-services.js | ✅ 已不可用（用户 2026-10-01 确认） |
| LITELLM_API_KEY | `16b35e76`（2026-07-22）openspec 归档 tasks.md | ✅ 已不可用（同上；内网 LiteLLM 亦已退役） |

发布闸门已满足。私仓 `gitleaks detect --source .` 仍会报这 3 处（历史对象不可变），属预期基线。

**注意**：branding.spec.js 测试夹具与 k8s/deployment.yaml 的 `volces-api-key=...` 占位符两个误报已由仓根 `.gitleaks.toml` 放行——该配置必须保留 `[extend] useDefault = true`（缺了它会把默认规则整体清空、扫描静默变绿，2026-10-01 踩过）。

## 2. 生成快照

**先过第 0 步：确认你要打快照的那条线是完整的。** 出片用的是**当前检出**的 `HEAD`
（`--ref` 默认 `HEAD`），而不是某个远端引用，所以两个坑都真实发生过：从一条落后于另一端的
检出打快照，镜像里就少了对方在途的功能；从一条次新检出打快照，会把对方已删的死代码带回来
（2026-11-08 两次坏片）。

```bash
# 两条 release 线是否真的分叉（用 patch-id 判，不会把镜像提交误报成分叉）
node scripts/check-release-lines.mjs --strict     # exit 0 才继续；2 = 双向分叉，先合并
```

```bash
# 默认取 HEAD；工作区未提交的改动中，只有 README*/LICENSE/.gitleaks.toml 会被覆盖进快照
node scripts/make-public-snapshot.mjs --init
```

- 想从指定线出片而不动别人的检出：`--ref gitee/release/cell-session-persona`（脚本接受任意
  ref，`git archive` 导出的是已提交树，未提交改动不会进快照）。
- 出片 sha 是**快照仓的 commit**，注释里同时写私仓真 sha。

- 想把在途代码（如 cells 迁移）带进快照：先在私仓提交，再重跑脚本。
- 脚本失败 = 验证不通过（清洗表失效/新泄漏/结构缺失），按输出修表或修文件后重跑；失败时输出目录会被删除。
- `--init` 会在快照里 `git init` + 单条 release commit。**注意：每次 `--init` 都是新目录，remote 需重加**——重发完整命令：

```bash
node scripts/make-public-snapshot.mjs --init
cd dist-opensource/platform
git remote add origin https://github.com/FindDataTechnology/platform.git
git push --force origin main   # 快照仓无共同历史，force 是常态
```

## 3. 发布（人工）

1. 公开仓已建：**https://github.com/FindDataTechnology/platform**（2026-10-01 上线，曾短暂名 fd-platform 后即时改名；门面三件套+homepage 已配齐）。快照仓 remote 指向它，重发时直接 push。
2. 推送：`cd dist-opensource/platform && git remote add origin git@github.com:FindDataTechnology/<repo>.git && git push -u origin main`。
3. Gitee 镜像可选（`FindDataTechnology/<repo>`）。
4. **门面三件套**（five-lines 规范，公开后立即补）：
   - 仓库描述：`[base] Local-first AI assistant platform on the DeepSeek Harness (dsh) runtime`
   - topics：`base`、`xunshu`、`mcp`、`ai-assistant`、`dsh`、`rag`、`electron`
   - README 横幅：已在快照内（脚本断言过）。
5. 可选：README.md 顶部加回 CI badge（指向新仓的 ci.yml；旧 badge 指向 fd-craw-private 已删除）。

## 4. 发布后维护

- **CI 现状（2026-10-02，run 6 起）**：**强制门全绿**（lint ✓ typecheck ✓ dsh-contracts ✓ unit ✓（614 测试 + 环境门控跳过）locales ✓ build ✓）；e2e **咨询态**（continue-on-error：约 4 条确定性失败在 dev 机同样失败——composer overflow / session-navigation streaming-stop / chat-outline hover / message-actions，属并行会话活跃赛道既有债，清零后翻转回强制）；CI 侧 dsh 自举钉了 cordis-plugin-hmr@1.0.16（dsh-matrix 同款）。**badge 门槛=run 全绿**（咨询态下即强制门全绿）。
- 私仓继续是开发主场；想同步公开仓时：私仓提交 → 重跑脚本 → 快照仓 `git pull` 不适用（无共同历史），用 `--init` 产出的单 commit 仓库可 `git remote add + git push --force` 或改为在公开仓上打 tag 重发。**建议节奏**：按版本 tag 发快照（v1.3.1、v1.4.0…），不发滚动 main。
- five-lines-public-surface 战役的 3.x 任务（描述/topics/横幅映射表）补登这个仓（base 线）。
- 新增文件若含内网信息，靠脚本验证兜底：禁忌模式扫描会 fail；清洗表要同步维护（scrub rot 会硬失败提示）。

## 5. 已知边界

- **2026-10-06 表维护**：新增排除 `docs/registry-maintenance.md`、`docs/spider-heal-pack.md`（内网运维手册）、`docs/adr/` 与 `docs/registry-fork-patches/`（内部决策/补丁记录）、`scripts/test-ops-console-board.mjs`（fleet board 测试）、`servers/fd-health-mcp/`（tailnet 运维 README）；新增 SCRUB（spider-heal-pack 的模型网关域名）；新增 ALLOW 豁免（谦面页脚联系方式 = facet-platform 规格强制的公开面，扫描豁免）。同日 facet/cli + facet/web 首次进入快照（npm scope 修正后）。
- 快照排除了：DEPLOY.md、PRODUCT.md、Makefile、Jenkinsfile、k8s/、argocd/、image.yml、openspec/changes/、三个内部能力规格（ops-console / live-service-testing / registry-market-deployment）、services/ops-console/、docs/vertical-packs*、.claude/.pi/.impeccable/、probe 与 live 验证脚本、本脚本与本 runbook。
- 快照清洗了：Dockerfile/agent-runner compose/.env.example/playwright live 配置等文件里的内网域名、tailnet/公网 IP、集群名、Jenkins/Harbor 引用、DEPLOY.md 指针（完整表见脚本 `SCRUBS`）。
- 公开面有意保留：www./craw./demo./mcp.finddatatech.cloud（公开域名）、微信 appid（公开标识符）、官网/产品线链接。
