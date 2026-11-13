# Design — wire-marketplace-json-curation

小切片，单文件单过滤点，四个决策即全部：

**D1 过滤谓词 = category∨featured（与浏览面同源）**。策展信号只有这两个字段
（add-facet-content-management 定案），浏览面 facets 与萬星目录 turns7d 的「featured
策展优先档」同源。不复用 turns7d（那是使用信号不是策展信号，D5 明写策展）。

**D2 白名单 = 覆写不是交集**。`FACET_MARKETPLACE_PACK_IDS` 已设时行为逐字节保持
（含可列未策展包）——运营显式点名是更强意图，且已设部署零迁移成本。这与开关门
（add-opening-gates）的「默认改、显式配置不动」同一纪律。

**D3 清单管发现，不管可达**。插件树三路由（plugin.json/SKILL.md/README.md）的可见性
门保持「公开非 unlisted」不变：版本不可变语义 + 直链可取是既有承诺（F1.1 出口判据
「任意包任意历史版本可视可取」），策展只影响 Claude 原生市场清单的收录。

**D4 分页保护**。`loadListed` 终止条件补 `packs.length === 0`：过滤使 `out.length`
可永小于 `total`，现状会空转扫到 50 页上限。防御性修复，随本切片捎带。

风险与回滚：行为变化仅「未设白名单的部署清单收敛」。回滚 = revert 单提交滚镜像；
fd-prod 首轮垂类归类已覆盖绝大多数在架包（legal×8/daas×6/text×2/doc-studio/生态版），
清单收缩预期有限，生产实证以 packs DB 对照核数。
