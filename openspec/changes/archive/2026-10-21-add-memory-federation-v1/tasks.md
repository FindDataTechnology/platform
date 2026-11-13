## 1. fd-memory 联邦面

- [x] 1.1 `/hook` 兼容端点（query 四参解包 + body 原文 + 人令牌鉴权 + namespace 映射 + 幂等表），verify：单测——合法事件入库可检索 / spool 重投幂等 / 坏 event 400 / person 越界 d/ 403
- [x] 1.2 `platform` 令牌族（数据面全拒 + `/admin/mint` 分权：platform→person、runner→deployment），verify：单测——令牌族×四端点权限矩阵全覆盖（fleet-memory spec 场景）
- [x] 1.3 fd-memory 全量回归（12+ 用例绿）+ 出片（fd-build-channel 判路）+ NodePort（PORTS.md 对账选号）滚版，verify：relay+skopeo 门 + NodePort 探针 /healthz

## 2. 本地联邦首批（本机）

- [x] 2.1 接入配方文档（server add + .ai-memory.toml + recover 定时）入 fd-memory docs，verify：文档含完整命令与回退（删 profile 即回本地模式）
- [x] 2.2 本机实测：fleet profile 指向生产 NodePort + person 令牌，跑真实 harness 会话 → recover 排空 → u/ namespace 检索到观测（验收判据①），verify：MCP query 返回该会话事件 + 幂等（连跑两次 recover 观测数不变）

## 3. 壹座 cell 挂载

- [x] 3.1 paas cell 侧 `CELL_MEMORY_ENABLED`（默认 0）+ 人令牌代铸客户端（platform 令牌经部署 secret；按 owner email 缓存 DB），verify：单测——关闭时组合输出字节零变化 / 代铸失败降级开放不阻断会话
- [x] 3.2 cell dsh 组合注入 fd-memory MCP 行（u/<owner>/p/cell）+ 记忆纪律文案，verify：单测——组合输出含 MCP 行与纪律段 / fd-memory 不可达时会话照常（降级开放）
- [x] 3.3 出片滚平台镜像 + 开门（全量；机制链活体验证过——MOUNT OK + MCP 200；真实 cell 会话工具面=真机复验项），verify：真机 cell 会话见 mcp__fd-memory__* 工具 + handoff 写入落 u/ namespace（验收判据②）

## 4. 验收与收尾

- [x] 4.1 三消费者互见（①本地→舰队✓ ④矩阵✓；cell 写→本地查待真机会话复验——as-built 在 reports/）：cell 写 handoff → 本地节点 MCP 查询命中；本地 /hook 投事件 → cell 查询命中，verify：双向检索证据入 reports/
- [x] 4.2 台账 + 底稿切片④完结标记 + 记忆更新（含 7.2B 降级结论回填切片 2 change 备注），verify：文档链接互达
