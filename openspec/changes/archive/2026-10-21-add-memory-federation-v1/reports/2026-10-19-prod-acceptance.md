# 生产验收记录（切片 4，2026-10-19）

判据①（本地节点 /hook 直投落库）✓：本机 stock ai-memory 3.0.0 注册 fleet profile
（NodePort 31899）+ 人令牌（platform 代铸 u/chengsishi）→ hook 事件 → `ai-memory recover`
排空 → **联邦首投实时落库可检索**；幂等实证（obs=1 / dedupe=1，重复 recover 不双计）。
launchd `com.finddata.ai-memory-recover` 小时循环已装。配方文档=fd-memory `docs/federation-recipe.md`。

判据②（cell 挂载）◐ 机制链闭合：platform 滚 sha-f6f0508 + CELL_MEMORY_* 开门（灰度=全量开门，
platform 令牌带外 secret fd-memory-platform）→ pod 内 cellMemoryMount 实测 **MOUNT OK +
代铸 person 令牌 MCP initialize 200**（namespace u/acceptance@finddata.cloud root 创建）。
**真实 cell 会话工具面（mcp__fd-memory__* 眼见 + handoff 写入）= 真机复验项**（需用户侧登录
对话触发一次新 profile 写入）。

判据③（三消费者互见）◐ 双向中的舰队侧通：本地投的事件在舰队可检索（①）；**cell 写→本地查**
待真机 cell 会话复验后闭环。

判据④（令牌族矩阵）✓：fd-memory 12/12 单测含四族×四端点矩阵（跨族铸造 403 / 格式 400 分义、
platform 数据面全拒、service tokens 无数据面身份）。

## as-built 偏差

- **CELL_MEMORY_URL 用 clusterIP 而非 svc DNS**：platform 是 hostNetwork + Default dnsPolicy
  （无 cluster DNS）——与 runner-serving 的 ClusterFirstWithHostNet 不同；clusterIP 随 fd-memory
  服务重建而变，**fd-memory 重建后须同步改 platform 清单**（记入两清单注释）。
- cell 人令牌缓存落在 platform `/data`（cell-memory-tokens/）而非每 cell 数据根：platform 是
  cell 组合的单点写者（writeMcpPatch 全收敛于此），owner 维度缓存在此正确；per-cell 数据根
  拆分留给部署形态演进。
- 验收用 namespace=u/acceptance@finddata.cloud（探针）；真实用户 namespace=owner email。

## 镜像台账

| 镜像 | tag | 源 | 池 |
|---|---|---|---|
| yizuo/fd-memory | sha-8d2a26d（/hook+platform 族+幂等） | fd-memory 1f83d9c+ | testaction005 |
| yizuo/platform | sha-f6f0508（cell-memory.js+CELL_MEMORY_*） | paas c58f07fb | testaction004（run 39187304206） |
