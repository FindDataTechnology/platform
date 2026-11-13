# Tasks: add-cockpit-orchestration-view

## 1. 前端

- [x] 1.1 `FleetsPage.tsx`:FleetDetail 类型加 orchestration;树上方编排面板(模式徽章+约束+边列表,ref→岗位名,fanout 聚合/event 信号源语义渲染,implicit 标记,未声明不渲染);五语言 i18n;验证:typecheck 绿 + 声明/未声明两态渲染断言(stub 走查)

## 2. 回归与出片

- [x] 2.1 既有十三套回归零新增红(纯前端);`openspec validate add-cockpit-orchestration-view` 通过
- [x] 2.2 出片随下一列车 + 真机眼见验收(公司式舰队 supervisor+handoff 边呈现)→ 台账补记
