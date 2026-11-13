# tasks

- [x] 1. gateway：pack_deployments/deployment_keys 三元组重建迁移（pk 位守卫）+
       recordDeployment/recordDeploymentKey/deployments/deploymentKeysForPack 全族
       带部署者维度 + 单测（迁移幂等/存量行兼容）
- [x] 2. 部署路由：作者部署原路径、非作者部署缀部署者段（d8）+ 同部署者原地升级 +
       覆盖语义收敛（他人部署永不被顶）+ 单测（A/B 双部署者独立地址与键/作者零变化）
- [x] 3. 管理动作归属：pause/resume/config/unbind/kill 按 (包,角色,部署者) 校验 +
       包详情部署清单查看者过滤 + 单测（本人可管理/他人同形拒/管理组通行）
- [x] 4. web：包详情部署清单归属呈现 + 五语言轻量键
- [x] 5. 验证面：tenancy 3/0+agent-serving 71/0+matters 4/0+runner matters 6/0+agent-runner 67/0+secrets 5/0+lock 0+wanxing-facade 34/0（pause/config 旧 403 断言按同形 404 新语义更新）；typecheck/biome/locales
- [x] 6. 上产：四面同代 → 生产双部署者实证（A 部署在役，B 部署同包→A 的地址与键
       不变、B 独立地址真回合）→ 台账 §15.52 + roadmap K8 销账 + 归档
