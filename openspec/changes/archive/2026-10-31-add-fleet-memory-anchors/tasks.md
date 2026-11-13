## 1. 四补丁实施

- [x] 1.1 补丁1 锚行：captureFleetTurnFact 收 meta（server.js 包装透传）+ 锚行格式（billed=input+cached+write，缺席 '-'）。验证：test-fleet-memory-anchors 锚格式两用例
- [x] 1.2 补丁2 分流：spec 钉住事实恒 f/ 观测恒 d/（零代码变化）。验证：spec delta 场景「分流——事实与观测各归其位」
- [x] 1.3 补丁3 swap 重排：事实先于清史落页 + 离任锚（末次回合 turnId/status/model/carrier，listTurnEvents 读）。验证：swap 锚用例（ledger 末行）
- [x] 1.4 补丁4 周报：server/fleet-cost-digest.js（aggregateWeek/moversLine/buildWeeklyBody/runFleetCostDigests）+ server.js 6h 定时接线。验证：周报四用例（聚合/movers/页面/sweep 周记账）

## 2. 回归与收口

- [x] 2.1 回归：fleet 面既有测试零红 + lint 清。验证：node --test 相关集
- [x] 2.2 真机验收：滚版后自然回合的 f/ 事实页带锚行；swap 一次看离任锚；周报页在下一 ISO 周首查（或手动 sweep 一次）。验证：pod 内 fd-memory 页面查询证据附 change report
