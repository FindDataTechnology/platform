# Tasks: add-wanxing-deployments-cache

## 1. 快照模块

- [x] 1.1 `gateway/wanxing/bookkeeping.js`：createBookkeepingCache（TTL/单飞/陈旧/
      硬窗）+ slug Map 索引 + 单测（TTL 命中、单飞合并、源失败供旧、硬窗降级）
- [x] 1.2 `diffDeployments` 纯函数（added/removed/changed 三桶）+ 单测（含无变化、
      键=agentPath、行内容比较）

## 2. 接线

- [x] 2.1 `resolveDeployment`/`listDeployments` 改读快照；枚举面（目录/卡片）硬陈旧
      503、A2A 解析不降级的分叉语义落地
- [x] 2.2 refresh 钩子接日志（v1），diff 导出注记指向 fd-wanxing 切片③

## 3. 目录分页

- [x] 3.1 `?page=&page_size=` 参数（钳制上限 200）、分页响应形状含 total、无参数
      保持全量——单测 + 既有 facade 套件回归全绿（playwright 无该面覆盖，live probe
      归 4.2）

## 4. 验收

- [x] 4.1 万级形态冒烟：合成 10k 行台账，resolve O(1)（p95 0.0009ms）、目录分页
      p95 达标（scripts/bench-wanxing-bookkeeping.mjs，可复跑；diff 10k×10k 19ms）
- [x] 4.2 staging 彩排一轮（真 packs internal API + 现有 3 部署），fd-prod 上线
      （待部署窗口；含 probe-wanxing-live.mjs 目录/分页断言复跑）
      —— 已随后续窗口上线并 2026-10-11 生产断言复跑收口：目录全量形状（无参数=
      legacy `{agents}` 无分页键，4 部署）、`?page=2&page_size=1` 切片正确且带
      page/page_size/total、`?page_size=999` 钳制 200——读路径即 bookkeeping 快照
      （M3② 目录 examples 验证走的同一链路）。快照降级分支（供旧/硬陈旧 503）单测
      在册（1.1），生产未触发。
