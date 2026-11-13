## 1. 计量叶与读面

- [x] 1.1 `lib/proc-memory.js` 零依赖叶：/proc 扫描（statm RSS + cmdline 归属）→ cellId 归组（cmdline 携带 `/data/cells/<id>/` 前缀）→ 四角色桶（cell-server/dsh-runtime/mcp-satellite/gateway）；cgroup v2 优先（memory.current/memory.max）v1 回落；macOS/无路径环境如实返回 `{available:false}`；秒级 TTL 缓存；验证：单测——Linux 伪 /proc 夹具三桶归组各一例 + 未归组余量透出 + 缓存窗口单次扫描 + 非Linux 降级标记
- [x] 1.2 `/api/monitoring/memory` 读面：三层响应（container used/limit/headroomPct → cells[]（totalMB+processes[]）→ gateway 桶 + 未归组余量 + sampledAt）；闸判定取 cgroup usage（D3），RSS 仅分布展示；验证：单测响应形状 + 生产真机 curl 眼见三层同框（对照 /proc 手算一例）

## 2. 驻留内存闸

- [x] 2.1 gateway spawn 前置闸：headroom 低于 `CELL_MEMORY_ADMISSION_FLOOR`（缺省 0.15）拒绝驻留，拒绝原因（用量/limit/余量/阈值）沿 lifecycle registry 既有决策记录通道落证据；验证：单测三态（余量足放行=行为零变化 / 低于阈值拒绝且原因四元组齐 / env=0 全放行）
- [x] 2.2 park-resume 前置同闸 + fail-open：计量不可用（available:false 或读值异常）时放行 + warn 告警，闸不阻断业务；验证：单测 fail-open 两例（无 /proc 环境、cgroup 值畸形）+ 已驻留 cell 不被驱逐断言
- [x] 2.3 headroom 恢复重试语义：被拒后恢复到阈值上的下一次请求正常驻留（无粘性拒绝）；验证：单测拒绝→恢复→放行序列

## 3. 运维坞渲染

- [x] 3.1 驾驶舱运维环内存水位卡：水位（cgroup usage/limit 比例）+ per-cell 分布摘要（RSS 降序）+ 低余量琥珀提示（复用既有琥珀组件与轮询）；验证：组件测试三态（正常无警示/低余量琥珀含四元组原因/计量不可用显示不可用标记）+ Playwright 一腿（e2e/fleet-memory-card.spec.js 四态含路由缺席，4/4 过）

## 4. 出片与走查

- [x] 4.1 出片：无新 COPY（lib/ 全量已在镜像）；`fd-build-snapshot` 照纪律出片 + relay 硬门 + GitOps bump（祖先律核过）；验证：生产 sha 面上 `/api/monitoring/memory` 眼见三层分布 —— **两轮出片**：sha-24cd11c（digest 114b8409）三层同框但逮出归组两缺口（gateway 相对 cmdline 漏归+dsh stdio 卫星 cwd=/app 零线索 970MB 落 ungrouped）→ 4e69a9d1 修复后 sha-8307188（digest 79dd9f3d）复验三层全归位（cell 16 进程 1598MB 全归属、gateway 110MB、ungrouped 仅余验证进程 10MB）
- [x] 4.2 闸投产观察：CELL_MEMORY_ADMISSION_FLOOR=0.15 上产一周，拒绝率与 OOM 频率对表（目标=OOM 清零或拒绝原因全部可解释）；验证：台账记录一周数据，Open Question（阈值调整/ B 线立项）据此定谳 —— **用户 2026-11-02 裁定提前收口（跳过整周观察）**：闸已上产（阈值透出读面），拒绝路径由单测 8/8 钉住；生产首证=滚版后新 image OOMKilled×1（13:45Z，闸前残留驻留挤占，闸只管新驻留）；`lastGateRefusal` 首发拒绝证据入 cells-registry 后可回看。Open Questions 留待数据自然积累回看
- [x] 4.3 台账 §15 内存限挂账收口注记 + 归档（validate --specs 全绿）
