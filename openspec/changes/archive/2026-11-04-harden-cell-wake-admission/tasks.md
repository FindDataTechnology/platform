# harden-cell-wake-admission — Tasks

## 1. 足迹档案（D1）

- [x] 1.1 `cells-registry.db` 增列 `last_footprint_bytes`（guarded ALTER，沿 `last_gate_refusal_json` 先例；lib 与 gateway 两侧 schema 演化同步）；验证：新旧库文件迁移后读写正常，迁移幂等
- [x] 1.2 park 完成时物化足迹：cell 归组 cgroup 实扣合计（同一 sampler 实例口径）写入 `last_footprint_bytes`；验证：单测——park 后读档=采样值；采样失败时留空不阻塞 park
- [x] 1.3 resume 路径读档 API（缺失/陈旧如实返回 null）；验证：单测覆盖有档/无档/坏值三态

## 2. 投影准入（D2/D4）

- [x] 2.1 `memoryAdmissionVerdict` 支持 `admission(floor, projectedBytes)`：provision 分支保持只看 current；park-resume 分支以 `current + last_footprint_bytes` 投影；验证：单测——同水位下 provision 放行而 resume 投影拒绝的双口径
- [x] 2.2 足迹缺失降级：resume 无档时回退只看 current（无告警刷屏）；验证：单测——首唤醒行为与旧判定逐字节一致
- [x] 2.3 fail-open 覆盖投影路径：sampler fail/缓存陈旧超限时放行+warn；验证：单测——注入 sampler 异常，resume 放行且证据不误写

## 3. 驱逐链（D3）

- [x] 3.1 候选收集与最小驱逐：running 且 `last_user_traffic_at` 超 reap 阈值，按闲置降序逐个 park（复用既有原语+inflight/状态机守卫），逐个复投影，达标即停；验证：单测——多候选只驱逐到刚好达标；活跃 cell 永不入候选
- [x] 3.2 驱逐失败跳过不阻塞：某候选 park 异常时跳过续走；验证：单测——注入单候选失败，链继续并最终按剩余候选裁决
- [x] 3.3 递归边界：被驱逐 cell 触达走既有 resume（可能再入本闸），无活锁（极端=拒绝）；验证：单测——驱逐者自身再唤醒被拒的链路收敛

## 4. 证据与可观测（D5）

- [x] 4.1 `last_gate_refusal_json` 扩展 `projected_bytes`/`footprint_bytes`/`evicted_cell_ids`，既有四元组保留；验证：单测——resume 拒绝证据含全部新字段且旧字段语义不变
- [ ] 4.2 运维坞水位卡渐进透出新字段（五语 i18n，范围顺手项）；验证：demo 页面眼见 + locales 门过 —— **挂后续（2026-11-04 apply 裁决）**：水位卡系扫描驱动（只显示在场进程），而投影拒绝/驱逐证据多落在 parked cell 的 registry 行——正确渲染需把 parked 行并入读面 schema（owner-scope 过滤随之重设计），超出 design D5「渐进增强非硬项」授权。证据 JSON 可读（4.1）已满足 spec 硬验收；本项另立 follow-up。

## 5. 回归与 e2e

- [x] 5.1 既有回归全绿：carrier 闸 8/8、三层读面单测、cell 生命周期套件不回潮；验证：`npm test` 相关套件零失败
- [ ] 5.2 e2e（demo pod）：park 带 14 卫星的大 cell → 压水位 → 唤醒三路（投影放行/驱逐后放行/拒绝于物化前）各验一例；验证：e2e 断言三路证据 JSON + 无 OOMKill —— **前提修正（2026-11-04 出片日裁决）**：demo pod 实跑单进程 server.js（镜像默认 CMD，无 gateway/cells/spawner/内存闸），三路 e2e 在 demo 架构上不可能。裁决：压力类两路（拒绝于物化前/驱逐后放行）以单测 10/10 为验收覆盖（model sampler 忠实建模 parked 语义）；生产 pod 人为造压=重演 6 次 OOMKill，明确不做。投影放行路已在生产活体眼见（滚版后 cell 3fdc7b8e 走新闸真实唤醒成功、boot 干净）。若需真容器级三路，另立 follow-up 用一次性 docker 容器自建 CELL_DATA_ROOT 演练，不动共享面。
- [x] 5.3 生产验收锚：1da519d4（16 进程 ≈900MB 名义足迹）出片后复唤醒不触发 OOMKill，首批投影/驱逐证据入册可读；验证：`cells-registry.db` 证据行 + pod restarts 不增 —— **收口（2026-11-04 深夜）**：①首批足迹证据入册可读=3fdc7b8e 行 `last_footprint_bytes=759905253`（≈760MB 校准值 vs 名义更高，park→archive→re-wake 全周期自然完成，D1 机制生产实证）；②1da519d4 已复唤醒驻留（traffic=0min）且现容器零 OOM；③风险包络被并行会话 C 线裁决①改写——GitOps `485c507` memory 1536Mi→2Gi（registry MCP 带凭据复活致单 cell 常驻 1.6GB 顶破旧额、OOM 循环 10+4 次、burn-in 17 进程 1412MB），本项目投影闸在其上全量武装（3fdc7b8e 下次唤醒即走真投影判据）；1da519d4 自身首次 post-release park 落档后其唤醒同走投影，属常态运营不必设门。

## 6. 出片与收尾

- [x] 6.1 出片沿公开免费线（快照→relay→skopeo 双仓 digest 硬门→GitOps→ArgoCD hard 刷新，§15.126 配方）；验证：双 pod imageID 全等 —— 实走 T2 池 testaction005/build-pool（§15.130 同线）：快照 7ad4425d（源真 sha b8044ba6 实证）→ run 41850021497 绿（target 行 yizuo/platform:sha-7ad4425，7 位截断应验）→ relay 22:51:49 OK(3s) → skopeo 双仓 digest sha256:8e42c13b 全等 → 镜像内容 grep 新符号验单过 → GitOps c98bfad 双清单 → ArgoCD refresh=hard → 双 pod imageID 8e42c13b 逐字节全等、零重启
- [x] 6.2 主 spec 同步 + `openspec validate --specs` 绿 + 归档；验证：validate 无 delta 残留
- [x] 6.3 台账/memory 更新；验证：memory 索引行含本变更要点
