# Tasks — add-memory-scopes-and-cluster-sharing

## 1. fd-memory：Scope 与 Grant 底座

- [x] 1.1 auth.ts：`TokenKind` 增 `pod`；tokens.db 增 `grants` 表与 `granted_at`；`mint` 按族写默认授予（deployment=agent rw+pack rw、pod=pack rw、person=owner rw）；新增 `scopesForNamespace` / `allows(tokenId, ns, mode)`（rw⊇r）；`scopeAllowsNamespace` 改为薄壳调 `allows`（runner d/* 与 platform 恒拒特判保留在数据面路由内）。验证：单测覆盖铸币默认授予矩阵、`allows` 的 r/rw 语义、撤销 pack 授予后共享拒而私有行。
- [x] 1.2 启动回填：migrate 阶段对全部未吊销既有令牌 `INSERT OR IGNORE` 默认授予。验证：单测先按 v1 形状建库再升级，断言回填幂等（二次启动零新增）且族正确。
- [x] 1.3 namespaceParts v2：`d/<packId>/<agentId>` → 根 `d-<packId>`/project `<agentId>`，`d/<packId>` → 同根/`shared`；新增 `safeSegment`（拒路径分隔符与 `..`，中文保留）并用于 d/ 段与 project 派生。验证：单测覆盖四类 namespace（含中文 agentId、`--` 含 packId）。

## 2. fd-memory：v2 磁盘布局与迁移

- [x] 2.1 RootDb 查询加 project 维度：searchPages/recentPages/recentObservations/openHandoffs 接受 project 集合过滤（默认全根，兼容 reindex）。验证：单测两 project 数据互不可见于对方的过滤查询。
- [x] 2.2 `scripts/migrate-v2.mjs`：以 tokens.db namespace 为坐标源搬 `owners/d-<pack>--<agent>/wiki/default` → `owners/d-<pack>/wiki/<agent>`，逐根 reindex，旧目录改名 `.v1-backup` 保留；`--dry-run` 打印计划；孤儿目录保守搬+告警；幂等。验证：单测建 v1 树+令牌跑迁移，断言新位置可检索、md 逐字节一致、二次执行零改动、dry-run 零写入。

## 3. fd-memory：MCP 面 target 与守卫

- [x] 3.1 mcp.ts：八工具 schema 增可选 `target`(own|shared)；读工具（query/recent/handoff_list）默认 own+shared 并集每条带 `source`、显式 target 收窄；写工具（write_page/handoff_begin）默认 own、shared 写共享区；pod 无 own（默认 shared、显式 own isError 说明）；person 的 shared isError。验证：单测覆盖成员并集读、写共享、pod 默认共享、person 拒 shared。
- [x] 3.2 `memory_handoff_begin` 共享区支持 `to_agent`（HandoffRow 增列 + frontmatter + accept claim-once 不变）。验证：单测 A 定向写 → B 认领成功 → C 再认领 already。
- [x] 3.3 按名寻址守卫：`memory_read_page` path 首段、handoff accept/cancel 目标 project ∈ 令牌可访问集，越界 isError/拒。验证：单测成员 A 读 B 私有 project 路径被拒；突变（去守卫）红。

## 4. fd-memory：project 面、审计、mint 放宽

- [x] 4.1 http.ts `GET/POST /pages`：按 project 名读写（请求者自身 root 内解析，无 namespace 参数）；`allows` 校验 + 写审计行；person 覆盖 owner 根全部 project。验证：单测 person 读写 clusterId project、deployment 越 project 拒、无令牌 401。
- [x] 4.2 RootDb `writes(ts, principal, scope, page_rel, op)` 表 + 页写/handoff 三操作/capture 批次落审计（try/catch 不阻断）；`POST /admin/report` 列 root 的 grants 与最近写入（runner/platform 可指定 rootKey，person 限自身）。验证：单测三次写入三行审计、report 结构与权限。
- [x] 4.3 mint 放宽：runner 铸 `d/` 2 段 → pod 族、3 段 → deployment 族；跨族与非法形状仍拒（403/400 分义不变）。验证：单测两段铸出 pod 且授予恰一条、三段行为同 v1。
- [x] 4.4 capture 路由经 `allows` 鉴权（runner d/* 特判保留；deployment/person 自身 ns 经默认授予放行）。验证：既有 capture 单测全绿 + 新增 pod 令牌 capture 拒（数据面只给 MCP/pages）。

## 5. fd-memory：评测 v0 与全量测试

- [x] 5.1 `fixtures/eval/`：spider-heal 集群回合 + serving 回合两份脱敏转录 fixture；`run-eval.mjs` 临时目录起服务→注入→任务派生查询→交接召回率 + project 隔离断言，进 npm test。验证：`npm test` 全绿且 eval 输出召回率基线数字。
- [x] 5.2 全量单测 ~20（在既有 12 基础上）+ 突变抽验（去 project 守卫、去回填各一红）。验证：`npm test` 与两突变门红。

## 6. paas runner：pod 挂载与 agentId 修正

- [x] 6.1 manager.js：`#memoryMountToken`/`#memoryEventObserve` agentId 取 `metadata.agentId ?? name`；`#spawnPod` 按 `route.packId` 铸 pod 令牌（`d/<packId>`）挂进共享 mcpServers、`memoryDiscipline` 随挂载注入；compose-acp pod 同改动。验证：memory.test.mjs 增 pod 组合用例（挂载行+纪律+成员观测各归因+铸造失败 fail-open 无纪律）。
- [x] 6.2 `npm run test:agent-runner`（或等价目标）全绿。验证：runner 侧全部既有测试不回归。

## 7. paas cell：集群回合两挂点

- [x] 7.1 `server/cluster-memory.js`：`clusterMemoryFor(env, ownerEmail)` 复用 person 令牌 + `/pages` 面实现 readShared/writeDigest，失败降级 null。验证：单测（mock fetch）读→块、败→null、开关关→null。
- [x] 7.2 cron-runner `runClusterTurn` 挂点①成员提示注入 + 挂点②digest 写回（失败 warn 不判败；owner 缺失跳过）。验证：cron-runner 测试新增两场景（有共享页注入/记忆挂了任务照常成功）。
- [x] 7.3 paas 全量相关测试绿（`node --test` server 相关 + runner）。验证：测试命令输出零失败。

## 8. 出片、迁移与验收

- [x] 8.1 fd-build-channel 判路 → fd-memory 与 paas（platform+agent-runner-serving）出片（GHA 链、双 smoke 门、digest 双证）。验证：三镜像 digest 在 hkccr+ccr 一致。
- [x] 8.2 生产迁移窗口：PVC 快照 → scale 0 → migrate-v2 dry-run→执行 → 新版本 fd-memory 起来 → 验收（admin/report、抽查 query、eval 对生产数据跑一遍）。验证：`.v1-backup` 在、旧根空、查询可检索历史。
- [x] 8.3 滚 runner-serving 与 cell：pod 令牌铸造落库（tokens.db 见 pod 族）、集群任务真跑一轮验证两挂点（digest 落 owner 根 clusterId project）。验证：生产 tokens.db/audit 行/项目页面眼见。
- [ ] 8.4 台账（docs/registry-maintenance.md §15.7）+ 主 spec 同步 + 归档（`openspec archive --yes`，validate --specs 165/0）。
