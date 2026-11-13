# add-vendor-supply-open · tasks

## 1. 供应商身份类（vendor-identity）

- [x] 1.1 落表：`vendor_profiles`（主体名大小写不敏感唯一索引、公开署名、联系凭据、配额档、收益归属字段）、`vendor_members`（绑定+角色）、`vendor_audit`；随 gateway/packs.db 迁移幂等（CREATE IF NOT EXISTS），套件引导即验证
- [x] 1.2 供应商主体注册/档案/绑定 REST 面（`gateway/vendors.js` 路由族），注册即得+409 名称冲突+缺字段如实拒；单测覆盖 spec 三 Requirement 全部 scenario
- [x] 1.3 资格判定改造：`gateway/packs.js:1039-1045` 单点改为 `isCreator || open || hasActiveVendorBinding`；回归既有 creators/closed/open 判定（test-facet-publish-gate/test-publish-rate-admin/tactical tool-face 24/24 全绿，无 vendor 绑定走原路）
- [x] 1.4 档案更新审计：变更字段级留痕；单测断言审计行内容（操作者/时间/字段）

## 2. 供方上牌闸（vendor-server-onboarding）

- [x] 2.1 `vendor_onboarding` 状态机表与路由族（提交/状态查/撤回/重试）；submitted→in_review→onboarded|rejected(axis) 流转单测全绿
- [x] 2.2 准入审查器：主体/材料/许可证/配额/同名槽位轴逐项评，拒绝带轴落台账；单测覆盖「材料不全」「禁证」「配额过闸」「同名槽位」scenario
- [x] 2.3 selfcheck 执行器：协议握手+工具列举+商业集闭包比对（复用 `probeMcpToolNames`/`registry-bridge` 工具面语义），独立超时预算与一次重试；fake MCP 探针测试「闭包超集被挡」「声明完好通过」「不可达分类」
- [x] 2.4 registry 写入适配：平台凭据 register+toggle（控制台 cookie+CSRF 通道，同 refresh-registry-tool-list 纪律），供应商无任何直写端点；registry 不可用时挂起 in_review+如实降级（不产生假在册），恢复后 retry 上牌——测试覆盖
- [x] 2.5 双形接入分岔：vendor-hosted（reach 端点+出站姿态材料）全链；platform-hosted 先行如实驻留（托管执行环境是运维通道，设计挂账，不伪装在册）
- [x] 2.6 供应商可见面：名下 server 状态列表 API（状态与台账一致，拒单带轴）；越权断言测试
- [x] 2.7 上牌的 server 可被 pack 以 `registryName` 引用：发布门+安装链回归（既有四闸语义逐字节一致——无声明工具的引用走原路全绿）
  > **观察项（本单不动，用户 10-27 裁决记录）**：发布层 local-binding 豁免 vs 安装层硬拒的 registryName 校验语义断层（`lib/publish-tool-gate.js` vs `pack-store.js:261-310`）——vendor 时代豁免可能成逃逸道，留给后续单独裁决，不写进四闸对外语义。

## 3. 市场作者开放与署名（pack-marketplace delta）

- [x] 3.1 发布归属声明参数：网关校验绑定后取档案公开署名投影进条目；manifest 自带 `vendor` 键 400（`manifest-attribution-forbidden`）；单测覆盖「归属进条目/无权署名拒/无声明不署名」
- [x] 3.2 条目呈现署名取档案当前值（version 行只存 slug 戳，读时投影）；档案改名后条目呈现随之更新（测试断言）
- [x] 3.3 发布门对 vendor 同轨证明：manifest 校验/工具面闸在 vendor 发布者身上跑既有语义同拒，速率限同轨（单测断言）

## 4. spec 裁决与收尾

- [x] 4.1 `ecosystem-curation` delta 内容核对落地：匿名提交面无、vendor 提交仍过审、mirror shelf 语义不污染（无代码触及该区），validate --strict 绿
- [ ] 4.2 registry fork 侧受控通道启用（**外部依赖：cheap-8 部署窗 + fork 自助注册面裁决**）：fork patch 已落并推 `fd-vendor-lane`（vendor_lane_routes 机器令牌 register/toggle+7 测本地绿，GHA 被该仓私有分钟欠款阻塞已台账挂账）；`docs/registry-fork-patches/2026-10-28-vendor-onboarding-lane.md`登记协议；paas writer env 开关 `REGISTRY_VENDOR_LANE=service-token` 已并入 21/21 绿——**部署窗+分支验收走批**让外部窗统一点检
- [ ] 4.3 `openspec validate add-vendor-supply-open --strict` 全绿（✅ 已过）；真机全真行走已编入 `scripts/test-supply-owner-acceptance-live.mjs` + `.github/workflows/live-supply-owner-acceptance.yml`（workflow_dispatch，公开仓 runner 免费跑；A 档=vendor/署名/价格/坞面/digest 全链可跑，B 档=onboarding 写入+付费环待 REGISTRY_VENDOR_LANE 部署窗 `inputs.accept_token_lane=1` 放行）— **等用户发车令走生产批次**

## 实施注记（2026-10-27 起棒实录）

- 实现文件：`gateway/vendors.js`（新）、`gateway/vendor-onboarding.js`（新）、`gateway/packs.js`（store+闸+署名戳）、`gateway/index.js`/`facet/index.js`（挂载）、`gateway/facet-proxy.js`（/api/vendors 转发）；测试 `scripts/test-vendor-supply-open.mjs` 20/20 绿。
- **并发冲突挂账**：`gateway/packs.js`、`lib/pack-manifest.js`、`docs/registry-maintenance.md` 当前混有并行会话（add-pack-locale-tracks / cell-lifecycle）在途 hunk，按纪律本会话不动这些文件的提交编排；vendor 线代码在工作树内已与全量单测互证，待 locale 线先落后再由后续会话统一提交。
