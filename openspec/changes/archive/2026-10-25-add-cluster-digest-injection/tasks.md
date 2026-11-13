# add-cluster-digest-injection — Tasks

## 1. fd-memory 平台缝 digest 读面

- [x] 1.1 `http.ts` 新增 `GET /digest`（鉴权同 /pages：person 自家 root、platform/runner 带 rootKey、agent 拒）：q 参数召回 `hybridCandidates`（进程内 sidecar embed 链 + 30s abort，失败关键词降级记 model_note）→ open handoffs → `renderDigest`；参数钳制 k≤8 / budget≤2000
- [x] 1.2 单测：权限矩阵三族 / embed 降级不失败 / 参数钳制 / 忘与过期条目不出现（渲染器既有测兜底，这里测端到端组装）

## 2. paas 集群 hook ① 切换

- [x] 2.1 `server/cluster-memory.js` 增 `readDigest(clusterId, q, {k, budget})`（5s 超时，env `CELL_MEMORY_DIGEST_K/BUDGET` 默认 5/1500）；`server/cron-runner.js` hook ① 改三档阶梯：digest → /pages 标题列表（现状路径不动）→ 无块，各档 warn 一行，开关关闭零发起
- [x] 2.2 单测：三档降级路径（digest 5xx/超时、/pages 失败、全失败）+ 开关归零字节等同（既有 cluster-memory/cron 测试扩展）

## 3. 网格定默认（接 add-continuation-eval 5.2）

- [x] 3.1 eval-continue digest 臂 k∈{3,5}×budget∈{800,1500} 4 组全 12 场景，重推导度主指标定终值；差异 <0.2 分维持 5/1500；结果入 continue-baseline + 回填 add-continuation-eval tasks 5.2 勾销——四组 re 3.33/2.83/3.50/3.17、fs 2.83/2.33/2.92/2.92，组间差不大于跑次方差（同参数自差 0.6 在案），无可分者，维持 5/1500

## 4. 出片与真机验收

- [x] 4.1 双端出片+滚产：fd-memory sha-586ab4e（testaction005 池，relay PASS，ccr 91dd2dc4，GitOps b085ce5）；platform 半班由平行线 add-principal-facade 搭车完成——a2fbfcd 含 15bc4261（merge-base 实证），生产三面 platform/platform-demo/facet 已跑（台账 §15.32 记「顺带捱上并行线 15bc4261 platform 半班」）
- [x] 4.2 真机验收（产 pod 内 drill，2026-10-25）：真实 env+真令牌+真 fd-memory 三档全过——档1 digest 块眼见（u-aloadtree/default 真实 open 交接两条进块，服务端渲染）、档2 精确回退历史标题块+warn 行、档3 双败 prompt 不变、回滚杆 CELL_MEMORY_DIGEST=0 生效、空 project 如实返空块不报错；会话留档级见证转为常设观察项（下一次自然集群回合，§15.31 ①在册）
- [x] 4.3 台账 §15.31 回填（上线记录 + 网格终值 + 观察项起点：认领率 8% 基线与 digest 引用前轮内容的首例）——见 registry-maintenance.md §15.31 补记二
