# Tasks — wire-marketplace-json-curation

- [x] 1. 实现 `facet/marketplace-json.js`：`loadListed` 默认过滤 `p.category || p.featured`；
      白名单已设时仅按白名单（现行为不变）；分页循环补 `packs.length === 0` 终止。
- [x] 2. 测试 `scripts/test-facet-marketplace-json.mjs`：
  - [x] 2.1 默认口径：未策展公开包缺席清单、setCuration(category) 后进清单、
        featured 单独为真也进清单、插件树直链仍可取。
  - [x] 2.2 白名单覆写：点名未策展包仍列出（不经策展二次过滤）。
  - [x] 2.3 既有四测（缓存头/插件树/版本不可变/unlisted 缺席）适配后全绿。
- [x] 3. 全量回归：facet 相关套件 + 主仓 lint（本地口径；e2e 走 CI）。
- [x] 4. 镜像出片（law-ai-official 快照线）→ ccr 验证 → GitOps facet.yaml 双远端滚动。
- [x] 5. 生产实证：marketplace.json 清单 == packs DB「公开∧¬unlisted∧(category∨featured)」
      集合（逐一对照）；白名单未设确认；Cache-Control ≤1h 不变。
- [x] 6. 收尾：归档 + 伞文档 K1 销账 + 市场线 D5 转 ✅ + OSS 快照同步 + 记忆。（镜像 sha-5ccc968=快照 5ccc968；GitOps 59b3b9b；生产实证 19/19 全等+未策展树 200+非公开 404）
