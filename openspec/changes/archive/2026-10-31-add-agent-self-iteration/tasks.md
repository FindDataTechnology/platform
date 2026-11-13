## 1. 记忆章程

- [x] 1.1 lib/pack-manifest.js：agents[].memory.guidance 校验（可选、非空、≤600 字，非法结构化拒绝）。验证：单测三态
- [x] 1.2 catalog.js entry 透传 memory；dsh-profile.js catalogEntryPersona 追加「【记忆章程】」尾段 + defs diff 自然重组。验证：单测 persona 组成两态（声明/未声明逐字节）
- [x] 1.3 双包样例（带/不带章程）组成对照。验证：快照式断言

## 2. 提案器与批准回调

- [x] 2.1 server/fleet-cost-digest.js：异常评估（四条全中）+ 提案投递（决策车道 carrier-change，provenance/证据链/在途去重）。验证：单测命中/不受理/去重三态
- [x] 2.2 routes/fleets.js 决策 op：carrier-change 批准回调（updateMember + captureFleetFact decision-resolved，不走铸版链）。验证：单测批准生效/驳回零变化
- [x] 2.3 回归：fleet/cost-digest/decision 面零红 + lint。验证：node --test 相关集

## 3. 真机验收

- [x] 3.1 真机：带章程 agent 的 persona 尾段落 profile；构造一发提案→人批→carrier 生效→还原。验证：证据附 change report
