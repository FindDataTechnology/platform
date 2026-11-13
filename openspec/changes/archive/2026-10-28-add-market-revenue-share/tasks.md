# add-market-revenue-share · tasks

## 1. 成交记与账本

- [x] 1.1 落表：`market_purchases`（买家/条目/版本/形态/价格/抽成比例快照/收益额/幂等键/状态/时间，append-only+幂等唯一键）；随 packs.db 迁移幂等，套件引导即验证
- [x] 1.2 收益聚合投影（`vendorEarnings` 每次从成交记重算，无计数器表）；settled/pending/抵扣池三项与逐行核对一致的测试
- [x] 1.3 反向行（refund 幂等行登记）+「原行不可改」约束：原行状态不被反向行改写（权益失效即「不动」语义）；测试断言余额回补/收益回转/权益失效/重放幂等

## 2. 购买与结算通道

- [x] 2.1 购买路由：buyer|pack|version(|period 期窗桶) 幂等键重放返回原成交行；余额不足带差额/条目不可售(not-for-sale) 两类如实拒且不留行；单测全 scenario
- [x] 2.2 结算执行：买家 sub2api 扣减（复用 `lib/sub2api-admin.js` adjustBalance subtract 先例）幂等键=`mkt_<成交行 id>`；pending→settle→失败挂账标 failed，同键重试接管；读面对 failed 如实（fake sub2api 失败注入测试）
- [x] 2.3 平台抽成：部署级默认档 `MARKET_SHARE_RATE`（缺省 30%，对齐 ADR-0022），比例快照入成交行；改档不影响历史行（split 随创建快照，测试断言 20→14/6）

## 3. 价格声明与市场面（pack-marketplace delta）

- [x] 3.1 版本级价格声明字段（once/period+期长, `parsePricing` 校验），发布时携带、随版本 immutable 锁定（改价=新版本）；免费条目回归（无 pricing 键，行为逐字节）
- [x] 3.2 列表/详情呈现价格与形态；购买动作入口（仅已登录）；匿名只读——PackDetailDialog 署名徽标+价格徽标+购买按钮+失败分类文案（zh/en 双语键）
- [x] 3.3 装前闸：`fetchMarketDetail`（远端 facet/本地 in-process 市场同缝）+ cell `POST /api/mypacks/install` 未成交 402 `market-purchase-required`；已装快照不拆（闸只管新装动作）；订阅期到期失资格入会商投影

## 4. 供应商收益视图

- [x] 4.1 供应商收益账 API：`/api/vendors/:slug/earnings`（名下成交列表+汇总 settled/pending/可用抵扣/已耗抵扣，投影可重算）；只见自己主体+admin 旁路；越权测试
- [x] 4.2 买家成交记读面：`/api/market/purchases/mine`（购买历史+抵扣池）；与收益侧同源（同一成交行两侧视角交叉断言）
- [x] 4.3 facet 呈现段：`VendorEarningsPanel`（MyPacksView 顶部，无 vendor 绑定纯缺席——免费作者面逐字节不变）消费上述 API

## 5. 收尾

- [x] 5.1 platform-billing 边界条款回归：调用量计费既有套件（test-vendor-supply-open 20/20 + test-facet-publish-gate/publish-rate-admin 24/24）全绿；静态断言 market.js 不触 usage 结算键轨
- [x] 5.2 `openspec validate add-market-revenue-share --strict` 全绿；自动化验收走查：供应商上架付费 pack→买家购买→买家扣/平台抽/供应商得三方数字同源→买家再装→调用不计市场账；真 sub2api 车道（余额读值真实回环）属外部联调挂账，与 vendor 4.2 同窗走
- [x] 5.3 web typecheck 全绿（packs-api 类型扩展 + VendorEarningsPanel + PackDetailDialog 购买流）

## 实施注记（2026-10-27 起棒实录）

- 落件：`gateway/market.js`（新，成交记/投影/购买/refund 路由）、`gateway/packs.js`（price 列+pricing 参数+purchased 投影）、`server/pack-manifest-source.js`（fetchMarketDetail）、`server/routes/packs.js`（装前闸）、`server.js`（localPackMarket pricing/market 透传）、`facet/index.js`+`gateway/index.js`+`gateway/facet-proxy.js`（挂载/转发）、UI（packs-api.ts/PackDetailDialog/VendorEarningsPanel/zh+en locales）、`scripts/test-market-revenue-share.mjs`（14/14）。
- 设计折中（design D2 落字）：抵扣池按买家绑定的 vendor 单池归属（credit_vendor_slug 最大池优先），跨多 vendor 绑定不拆行；提现通道 v1 不接（闭环抵扣）。
- 挂账：①真 sub2api 余额回环联调（fake 客户端已验证两套幂等键形状）；②registryName 断层观察与 registry 通道同窗（vendor 4.2）；③共享区文件 packs.js 等仍在 locale 线混排，提交编排同前笔（仅 openspec 目录入 commit）。
