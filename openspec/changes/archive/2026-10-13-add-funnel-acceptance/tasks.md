# Tasks — add-funnel-acceptance（F3.3）

- [x] 1.1 vertical manifest 撰写+校验器对拍（inline skill+serving 契约）
- [x] 1.2 跳①：本地实例发布；跳②：CLI 回流官方（保持公开 listing ev5E51eth7e5McvyDrl9Rg）
- [x] 1.3 跳③：控制台部署（目录收录 deployable:true+向导端点+部署者键绑定）
- [x] 1.4 跳④：外部调用者真金回合（506 字真速览，15.5s，settled）
- [x] 1.5 跳⑤：分成落账（$0.10→share $0.07×4 行；失败回合 waived 负保护实证）
- [x] 2.1 案例卡 docs/ecosystem/selfhost-funnel-case.md（五跳实录+身份拓扑+诚实边界+四坑）
- [x] 2.1b **验收发现真缺陷即修**：并发双部署拧断 billing_key_ref（4dd46b2 部署
      互斥+test-deploy-lock.mjs 2/2 无锁复现实证）；镜像随本片滚
- [ ] 2.2 归档+路线图 F3.3 ✅（F3 全片收口）+记忆

## 验收实证（2026-10-13 生产）

- 五跳全通：本地实例发布（`Bk1x3Qk0RQMbta_hSa_PZw`）→ CLI 静默续登回流官方
  （`ev5E51eth7e5McvyDrl9Rg` 公开保留）→ 目录 deployable:true+控制台部署（部署者键
  绑定）→ 外部调用者（用户 73≠部署者 78）真回合 **506 字固定版式速览**（15.5s）→
  usage settled（1min×$0.10）→ earnings **share $0.07/回合×4**（抽成 0.30；
  20ms 失败回合 waived=负保护实证）。
- **验收挖出真缺陷并即修**：并发双部署拧断 billing_key_ref（registry pk_ed3f≠库表
  pk_be09）→ runner 取死 ref 静默回落共享键。修复 4dd46b2（packId 承诺链部署互斥）+
  test-deploy-lock.mjs 2/2（交错 stub 无锁复现 desync 实证；跨 pack 并行时延断言）；
  agent-serving 58/58 回归绿；镜像 sha-dadf3ea facet 面滚+滚后真回合复验健康。
- 挂账（案例卡在册）：车道≠dsh 花名册（部署只验车道，花名册外模型静默空返且
  outcome:ok 照常计费）；免费车道 429 拥挤（部署键改绑 openrouter 组处置）。
- 调用者停权自愈链实证：余额不足→结算连败 30×→CALLER_SUSPENDED→充值 $2→pending
  扫尾结算成功→停权自清。
