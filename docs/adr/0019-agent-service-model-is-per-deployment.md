# Agent 服务的模型逐部署选择，弃 runner 级单模型（D8 翻案）

2026-10-07，萬星 agent 配置层（服务配置/调用者偏好）定形时翻案。add-a2a-agent-serving 的设计 D8 白纸黑字把 LLM 定为 runner 级：`AGENT_RUNNER_LLM` 一个 env，runner 内所有 child 共用，理由是运维简单。但配置层的核心维度就是模型——没有模型的配置页是空壳：部署者无法按服务区分成本档与能力档（爬虫自愈用 flash、推理重的服务用深档），只能动 runner env 波及全体。**决定：模型成为服务配置（Service Config）的一个字段，逐部署生效——registry agent entry 的 descriptor 携带 effective model，runner 据此为各 child 取 LLM，未设置者回落 `AGENT_RUNNER_LLM` 默认（向后兼容）。选项合法性以部署键（Deployer Key）在 sub2api 的 group 车道授权为准，作者可在 serving contract 里声明白名单进一步收窄；合法性在**配置写入时校验**，不让服务带着未授权车道上线后运行时 404（llm-model-discovery 实录教训：group 不绑即 404）。模型变更经升级同款的排水重生通道生效（5 分钟窗内排干在途回合、child 重生）。**

## Considered Options

- **维持 runner 级单模型**（D8 原状）：运维最简，但配置层失魂，部署者对"这个服务用什么模型"无从下手——弃。
- **模型下放到调用者偏好（per caller）**：计费按时长结算（ADR-0014），调用者选模型只移动平台成本、不动自己付费，车道选择属于套餐（Plan）的策划维度，不是调用者自由选项——弃（词条「调用者偏好」已载明此边界）。
- **逐部署模型（本决策）**：部署者出钱驻留、按服务选档，与部署键的车道授权天然对齐；代价是 runner 内 child 各持模型，配置面需写入时校验。

## Consequences

- 一个 runner 同时承载不同模型的 child；内存足迹模型不变（仍一 agent 一 child）。
- 配置写入时须做车道校验（对 sub2api group 绑定的可用模型求交），非法选项在 UI/API 层拒绝。
- 升级不重置部署者的模型选择：服务配置挂部署不挂版本（Overlay 差异语义，未覆盖字段跟随新 manifest 默认）。
- runner 的 LLM 管线（含 `LLM_PROVIDERS_STORE` 路由真件）需接受逐 child 覆盖——本决策隐含的实现工作量主体在此。
- supersede：取代 add-a2a-agent-serving 设计 D8 的「runner 级 by design」条款；`AGENT_RUNNER_LLM` 从唯一真源降级为未配置时的默认值。

## 修订注记（2026-11-05，add-model-session-boundary）

模型变更的生效通道由「升级同款的排水重生」改为**会话边界热切**，本 ADR 原文不重写、于此注记修订。改判的依据是两个后续事实：① pod 共宿（add-dsh-pod-adapter）后任一成员的 identity 变更排干整个 pod，数百 agent 密度目标下模型变更是 churn 平方项；② `preset/set + model/set` 的会话边界热切机制已在活体内运行（pod 成员会话首用时逐成员停车预设与模型），当时说「不引入第三种重启通道」时该通道尚不存在，如今它早已在产。

修订后的生效语义为三通道：① descriptor 无感字段（节奏、预算、卡片展示）维持五分钟轮询窗；② **模型变更经会话边界热切**——runner 停车图被运行时原位更新（pod 成员行 / solo 单成员同构），**新会话取新模型、变更时已在途的会话保持旧模型直至其结束**，窗内新旧并存是设计语义而非不一致，不排干 child、不重启进程；③ 其余组合级字段（persona、skills、MCP 白名单、预算物化等）维持升级同款的排水重生。原约束「不引入第三种重启通道」改写为：**进程级重启通道仍只有排水重生一种，会话边界热切不是重启通道**——它不中断任何在途回合，只是新会话的组成原语（与 pod 成员首用停车同构，组合身份不漂移）。

边界与例外：模型合法性仍在配置写入时校验（部署键 group 车道授权），运行时热切只接受 descriptor 携带的已授权车道，校验语义零变化；resume 路径按停车记录解析旧模型，既有同构语义不变；无停车图面（parked-face surface）的 harness（模型物化于 spawn）对模型变更保留升级同款排水——静默陈旧比排干更糟。
