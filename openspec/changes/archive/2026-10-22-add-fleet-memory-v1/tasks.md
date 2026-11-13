## 1. fd-memory 仓脚手架

- [x] 1.1 建 `~/finddata/fd-memory`（git init、TS/Node 22、npm 脚本 test/build/start、目录骨架 src/{store,auth,capture,mcp,admin}/），verify：`npm test` 空跑绿 + `node dist/index.js --help` 打印服务/admin 子命令
- [x] 1.2 OKF 兼容 fixture 入库：从切片 1 试点数据目录（`~/Library/Application Support/ai-memory`）拷录最小集（wiki 页面 + 月度 ledger + 一条 handoff）为 `fixtures/okf-3.0.0/`，verify：fixture 目录含 ≥3 类页面类型且 frontmatter 字段与 `docs/okf.md` 映射一致（人工核一遍记录在 fixture README）

## 2. 存储核心（OKF 层 + 派生索引）

- [x] 2.1 OKF 读写层：markdown 页面解析/序列化（frontmatter 类型/kind/title/tags/generated/sources/status + 扩展键保留）、按类型目录、月度 ledger 追加，verify：单测往返（parse→dump→parse 语义等）+ fixture 读入不丢扩展键
- [x] 2.2 store-root 布局与 owner 路由：`owners/<ownerId>/{wiki,db}` 每 root 独立，namespace（u//d/）到 root 的解析器，verify：单测覆盖两个 owner 各写各读、任何 API 面拿不到对方内容
- [x] 2.3 SQLite 派生索引：FTS5 页面/观测全文表 + 会话表 + 交接表，`reindex` 全量重建命令，verify：删库重建后 fixture 数据 query 结果与重建前一致且 wiki 真源逐字节不变（spec「派生索引损毁可重建」场景）
- [x] 2.4 git 版本化：store-root 内 wiki 树自动 commit（写入后 debounce 批提交），verify：写入一页后 `git -C <root>/wiki log` 出现提交

## 3. 令牌与鉴权

- [x] 3.1 令牌铸造/存储/吊销：`fdm_` 令牌、SHA-256(token‖pepper) 落库、deployment（单 namespace scope）/person（u/ root scope）两族、admin CLI `token mint/list/revoke`，verify：单测——铸造→有效请求→吊销→同令牌请求即刻 401（spec「吊销即时生效」）
- [x] 3.2 请求中间件：每请求解析令牌→owner/scope，越界（scope 外 namespace）结构化拒绝，verify：单测覆盖无令牌/伪令牌/越界三态（spec「令牌两族且每请求鉴权」三场景）

## 4. capture API

- [x] 4.1 hooks 形状事件端点：session-start/user-prompt-submit/pre+post-tool-use/stop/session-end，payload 兼容上游 hooks 字段（agent/event/session_id/cwd/tool_name/tool_input 摘要），按会话归并成会话页+观测，verify：单测投递一批事件后 query/recent 可检索（spec「manager 代采落库」）
- [x] 4.2 静态脱敏：入库前四类规则（PEM/已知 token 格式/bearer/带标签 secret），verify：单测注入含 sk-/ghp_/AKIA/PEM 样本断言零残留（试点判据②同款十模式）

## 5. MCP 面

- [x] 5.1 streamable-http MCP 端点（协议 2025-03-26、Authorization 头、SSE 响应帧），连接期 scope 绑定，verify：用切片 1 试点的手写 MCP 客户端模式连上并列出工具八件
- [x] 5.2 handoff 四件套工具：begin（summary/open_questions/next_steps/files_touched/归属）、list、accept（恰一次——两条 state='open' 守卫，对齐上游语义）、cancel，verify：单测「跨 harness 认领一次」场景（B 认领成功、C 得已认领态不改归属）
- [x] 5.3 query/recent/read_page/write_page 工具，scope 收窄到令牌 namespace，verify：单测两 namespace 互查为空（spec「工具面 scope 收窄」）

## 6. paas runner 接线

- [x] 6.1 `AGENT_RUNNER_MEMORY_ENABLED`（默认 0，字节级零变化纪律）+ 令牌解析（runner 令牌 capture-only；agent 侧挂载令牌经 runner-only `/admin/mint` 代铸并缓存——as-built，见 design D3 修订），verify：开关关时现有 runner 单测全绿无 diff（11/11）
- [x] 6.2 manager 代采客户端：turn 完成路径上组批（工具调用摘要+回合/会话边界）异步 POST capture，失败退避+静默缺口记录，verify：合同测试——假 capture 端点收到带部署令牌与 session 归属的事件批；端点 500 时回合主路径不受影响（spec「记忆面停机不阻断回合」）
- [x] 6.3 记忆挂载注入：dsh 侧 compose 追加 mcp.patch 条目、ACP 侧 spawnSpec.mcpServers 追加（materializer 同纪律），verify：memory.test.mjs 挂载行形状（dsh loader 行/ACP SDK 行）+ CLAUDE.md 纪律注入 + 禁用时字节等同（7/7+回归 11/11）
- [x] 6.4 persona 记忆纪律文案常量（`agent-runner/memory-discipline.js` 单点）接入 dsh persona 后缀与 ACP CLAUDE.md 追加，verify：单测两路产物含同一段文案（compose.js solo/pod persona 行与 compose-acp CLAUDE.md 同源 MEMORY_DISCIPLINE）

## 7. 联调与合同测试

- [x] 7.1 本地全链联调（形态=进程内 e2e 脚本 scripts/e2e-local.mjs，比 docker-compose 更轻：同链路 mint→capture→handoff→claim-once→双面 query）：fd-memory 服务 + runner 模拟（dsh 假 harness + ACP 假 harness）跑通「回合→观测落库→handoff 写→另一会话认领续作」全链，verify：`node scripts/e2e-local.mjs` → E2E PASS（观测与 handoff 页两路 query 命中）
- [x] 7.2 OKF 互读验证（**as-built 收口**）：A 向成立——fd-memory 解析/索引真实 ai-memory 3.0.0 产物（fixtures/okf-3.0.0 往返+检索测试绿；Scope Manifest 清单已对齐上游形状）。B 向受阻实证——stock `reindex` 是既有 scope 的重建器而非冷导入器（空库+清单=0 workspace；预埋 workspaces/projects 行亦未被 pass2 采用）；**联邦需求已由切片 4 以 hooks wire + recover 排空通道落地（不依赖 OKF 冷导入），OKF 双向冷导入留独立 spike，挂账于 fd-memory v1.1 待办**

## 8. 出片与部署

- [x] 8.1 出片（fd-build-channel 判路先行：fd-memory=通用池 testaction005 三轮 sha-f170dae/f73eef0/b2fc387；platform=通用池 testaction004 sha-54da09c 池内 image.yml 默认根 Dockerfile——scs001 公开线只作 CI 门），verify：relay OK + skopeo digest 硬门全过、台账 §9 在册
- [x] 8.2 舰队部署（cheap 集群 fd-prod ns，cheap-4 单实例+PVC 5Gi；runner-serving 同节点滚 sha-54da09c + AGENT_RUNNER_MEMORY_* 开门，令牌走带外 secret fd-memory-runner；pepper 走 fd-memory-env secret；**容器无 git→快照降级可选**，每日快照 cron 留待 git 侧方案），verify：ArgoCD GitOps 全程 + rollout 绿 + 探针/验收全链

## 9. 生产验收与收尾

- [x] 9.1 生产验收（reports/2026-10-19-prod-acceptance.md）：dsh 部署 spider-heal 真实回合写 handoff→跨会话认领 claim-once ✓；停机降级（scale 0 回合照常）✓；manager 代采观测+会话页+handoff 页落库可检索 ✓；ACP 生产部署缺位——测试层覆盖、补验留待首个真实 ACP 服务（as-built 在案）
- [x] 9.2 台账与底稿更新：`docs/memory-and-stats-plane-explore.md` 切片 2 完结标记、registry-maintenance 发布记录、记忆文件更新，verify：registry-maintenance §1/§9 + explore 底稿切片②完结标记 + 记忆文件更新，链接互相可达
