# design

## D1 · 地址段 = 部署者派生 8 位码，作者部署不缀段

服务地址 `/packs/<packId>/<agentId>` 对**包作者**（及全部存量条目）逐字节不变；
**非作者**部署注册到 `/packs/<packId>/<agentId>/<d8>`（d8 = sha256(部署者邮箱) 前
8 hex，稳定 → 同部署者重复部署命中同地址 = 原地升级）。选段而非重排 agentId：
slugFor 归一后目录/对话车道寻址零改动，路径可读性保留，冲突空间与端口规划
（ Occupancy 按路径）天然扩展。

## D2 · 表重建迁移按 PK 成员探测

SQLite 不能改主键 → 建 `*_t2` 新表（三元组 PK）+ `INSERT SELECT` 搬家 + DROP 旧表
+ RENAME。**迁移守卫 = `PRAGMA table_info` 里 deployed_by 的 pk 位**：旧表 deployed_by
不在主键（pk=0）才执行重建；新表该列已在 PK（pk>0）→ 跳过。幂等、启动零成本。
存量行的 deployed_by 即归属，搬完即兼容（地址不变）。

## D3 · 部署路由的覆盖语义收敛为"本人原地升级"

deployHandler 不再看 `registry.deployments(id)` 全包判断占位，而是按
(包, 角色, 部署者) 查本部署者自己的部署：有 → 原地址升级；无 → 新地址注册。
registry.recordDeployment / recordDeploymentKey 随三元组落行。capacity 水位线
"新增子项才闸"语义不变（按路径判新）。

## D4 · 管理动作归属（D-A 类收口顺手）

pause/config/unbind 等生命周期路由的归属校验从「包作者或创作者组」收敛为
「本部署的部署者或管理组」（包作者保留全量——包是他的内容）。包详情部署清单
按查看者过滤（本人；作者与管理组全量）。`matters` 已带 deployer 维度零改动。

## D5 · 非目标与风险

- registry（fd-registry 仓）零改动——路径只是字符串，agent 条目模型无主键约束。
- 端口空间：每部署一个监听口，span 32 → 单 runner 同主机 32 个部署位；
  容量水位线与 fleet 分片自然分流，不另设配额（开放初期量级远够，欠账观察）。
- 部署者段泄露的只是部署者身份的 8 位哈希——不可逆、不可枚举，不构成隐私面。
