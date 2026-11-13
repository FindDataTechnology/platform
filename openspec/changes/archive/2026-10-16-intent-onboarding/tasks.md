# Tasks: intent-onboarding

## 1. recipe 数据与档案存储

- [x] 1.1 `packages/core` recipe 静态数据（version、ready 清单、legal/stock/economic 三配方；pack/expert/预设键引用）
- [x] 1.2 意图档案存储（cell 内 per-user：roles、note、skipped、timestamps）+ env 预置（`ONBOARDING_DEFAULT_ROLES` 等，stored>env>empty 解析序单测）
- [x] 1.3 plan 生成器：recipe×准入集过滤（role-system D4 规则）→ 可装项清单 + unavailableNote；市场关退化两行

## 2. REST 与装配

- [x] 2.1 `GET /api/onboarding/profile`（self：档案+就绪角色清单）
- [x] 2.2 `POST /api/onboarding/answers`（self；原子写档案+主/副角色，self 通道永不触 admin 位；校验 roles 1..3 且均在就绪清单，非法 4xx）
- [x] 2.3 `POST /api/onboarding/provision`（self；逐 pack 既有订阅路径+准入校验+幂等；设默认专家；单项失败标注不中断）
- [x] 2.4 原子性与幂等单测（档案+角色同写同不写、二次激活零变化、卸载永不存在）

## 3. 前端

- [x] 3.1 `ChatWelcome` 问卷面板（角色卡 1-3 多选+待办注记+跳过；profile empty∧¬skipped 才现）与提交后一键确认清单视图
- [x] 3.2 `OnboardingTour` 第一步锚点融合（面板存在时锚问卷，否则回落既有锚）
- [x] 3.3 设置 General 分节"重新选择角色"入口（预填重开）
- [x] 3.4 五语言 locale（zh-CN 先行）：角色卡文案、清单文案、尾注；`npm run check:locales` 绿

## 4. 测试与验收

- [x] 4.1 e2e：首入→选 legal→激活→默认专家=合同审查官、提示卡随包、布局按 legal 预设解析
- [x] 4.2 e2e：跳过→面板不再现→角色解析不变（standard 基线）
- [x] 4.3 e2e：重开换 stock→布局/默认专家切换、已装 legal 包保留（只加不减）
- [x] 4.4 e2e：非就绪角色（financial 等）不出现在问卷卡中
- [x] 4.5 e2e：市场关部署清单退化为"工作面+默认专家"两行且激活成功
- [x] 4.6 存量基线：已有用户（已答或已跳过）欢迎态与主分支一致，存量 e2e 零改动全绿
- [x] 4.7 `openspec validate intent-onboarding --strict` 绿（依赖：role-system、layout-configuration 已 apply）
