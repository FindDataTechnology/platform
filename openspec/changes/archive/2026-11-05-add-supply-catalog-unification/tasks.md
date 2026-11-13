# Tasks: add-supply-catalog-unification

## 1. 谦面目录端点族（facet/）

- [x] 1.1 facade 公开投影端点 `/api/facades-catalog`：从内部 deployments 面投影，准入=公开分享态，字段=名称/简介/部署出处/状态（回报缺失输出 `status:"unknown"`）+ 注释投影（locale 解析链，无注释 zh 兜底）。验证：匿名请求只见公开分享态 facade；group 私有/未分享实例 404/缺席；带 `locale=en` 时注释条目出 en 轨。
- [x] 1.2 data-anchor 端点 `/api/data-anchors-catalog`：消费 DAAS 目录喂给（见 2.x），provenance.source=`daas-catalog` + as-of；注释投影同链。验证：条目 provenance 逐条可达；观测值类不出现。
- [x] 1.3 目录端点族物种元数据：五物种枚举 + 版本号随 `catalog.json`/端点族暴露；现有三端点（marketplace.json / mcp-catalog / skills-catalog）形状零改动。验证：旧消费方（plaza-export 旧版、CLI）回归不受影响。
- [x] 1.4 facet 侧 DAAS 拉取任务：定时拉 DAAS 目录导出（端点或导出文件），幂等入目录投影；源缺席时该物种计数为 0 且标明源缺席。验证：手动触发拉取两次，条目幂等；源不可达时 last-good 保留 + 告警日志。

## 2. DAAS 目录喂给（跨仓 finddata 根，只读导出）

- [x] 2.1 DAAS/business-mcp 侧只读目录导出端点（或定时导出文件）：v1 范围=实体+指标目录类（对齐 daas-supply-domain 元数据同步器口径），观测值排除，输出含稳定 id/名称/口径摘要/as-of。验证：导出条目数与 `daas` PG 目录表计数一致；两次导出幂等。
- [x] 2.2 导出端点接入 facet 拉取配置（URL/凭据/周期进 facet 配置面）。验证：1.4 的拉取任务对真实端点跑通一个完整周期。

## 3. 壹座读路径切换（server + 快照生成）

- [x] 3.1 `scripts/export-market-snapshot.mjs`：从目录 API 族导出生成 `market-catalog.json`/`market-catalog-skills.json`（带 `_meta.as_of`+来源 provenance），替换仓库内手编文件。验证：无配置启动 `/api/extensions/market` 返回快照内容且 as_of 可见；零配置三件套（fetch/time/demo）在快照中 `requiresConfig===false`。
- [x] 3.2 装载器加 `FACET_CATALOG_URL`（可选 `FACET_CATALOG_TOKEN`）在线源：服务端拉目录端点族映射为 market entry 形状（MCP→网关 configTemplate，`requiresConfig` 推导不变）；TTL 刷新 + `market_changed` WS 广播沿用；**删除 bundled-赢合并规则**（无合并、无冲突处理）。验证：配置后 `/api/extensions/market` 逐条等于目录投影；改目录后 TTL 内 WS 收到 `market_changed`。
- [x] 3.3 `MARKET_REGISTRY_*` 兼容窗：单独配置时仍工作但每次刷新 log deprecation warning；与 `FACET_CATALOG_URL` 并存时后者赢并告警点名被忽略变量。验证：三种配置组合（仅旧/仅新/并存）行为符合 spec 场景。
- [x] 3.4 拉取失败韧性：在线源不可达时保 last-good + 告警，市场不空。验证：指向不可达 URL 后旧条目仍在服务、日志有 warning。

## 4. plaza 导出五物种（scripts/plaza-export.mjs）

- [x] 4.1 接入两新物种源：facade 取 `/api/facades-catalog`、data-anchor 取 `/api/data-anchors-catalog`；删除 category 推导中的 badge/名称启发式分支（`pack.badge==="facade"/"assistant"`、`/data|daas/i` 正则两处）。验证：带 facade badge 但无部署记录的 pack 不再出现在 facade 物种。
- [x] 4.2 G1 对账 gate 扩五源：facades 对端点计数、data-anchors 对端点计数，任一物种计数不符即 fail 命名物种与两侧计数、零产物落盘。验证：fixture 注入计数漂移时导出以非零退出且 generated/ 无新文件。
- [x] 4.3 五物种材质页：facade 页载部署出处+状态（缺失出 unknown 标记）；data-anchor 页载 DAAS provenance+as-of。验证：`test-plaza-export.mjs` fixture 五物种断言全绿。
- [x] 4.4 全量真跑：对生产 facet 基座跑 `node scripts/plaza-export.mjs` + `scripts/test-plaza-site.mjs` 五语 parity。验证：五物种计数=三源对账全过、hero/counts.json 一致。

## 5. 验收与文档

- [x] 5.1 三面对账：壹座三柜（pack/技能/MCP）× 谦面橱窗 × plaza catalog 同刷新窗逐条对账零漂移（名称/简介/provenance/计数）。验证：对账脚本或逐条清单留痕。
- [x] 5.2 回归：无配置部署路径（快照兜底）、WS `market_changed`、安装路径组门控（`web-operate-states` 相关 e2e 不回归）。
- [x] 5.3 伞文档注记：`docs/facet-wanxing-roadmap.md`、`docs/facet-market-roadmap.md` 头部加「谦面轨道定位以 docs/supply-domain-roadmap.md 为准」注记行。验证：两文件头部注记在场。
- [x] 5.4 `openspec validate add-supply-catalog-unification --strict` 通过，且归档前 tasks 全勾对账（测试 ↔ 勾选一致）。
