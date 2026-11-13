# add-u-root-distillation — Design

调查依据（2026-10-25 晚，生产 pod 实测）：d/ 根蒸馏健康而 u/ 根 L2=0；distillOne 原料 = observations + handoffs（双 cursor）；u/ 根 observations=0（MCP 写的 note 不是 observation）、note 页不在原料内；fallbackScan 的 project 发现走 recentObservations——对 u/ 根恒空。

## D1 闸门：两处 `d-` 放宽为 `d-|u-`，部署开关 FD_MEMORY_DISTILL_U

`notifyCapture`（distill-scheduler.ts:88）与 `fallbackScan`（:142）改 `isDistillableRoot(rootKey, env)`：`d-` 恒真；`u-` 需 `env.FD_MEMORY_DISTILL_U !== "0"`。开关关闭 = 人根完全不进 pending/扫描，行为与今日字节等同。notifyCapture 的 u/ 触发源暂无调用方（chat 会话边界不上报），留着接口对称；实际驱动靠 fallbackScan（10min 周期，人根页量级下足够）。

## D2 note 进蒸馏原料：合成 observation 形状

distillOne 的 items 增加第三源：该 project 内 `created_at > state.note_cursor` 的 note 页（db 新增 `notesAfter(project, cursor, limit)` 查页索引），合成 `{kind: "observation", session_id: note.path, at: updated_at, event: "note-write", tool: "memory_write_page", summary: `${title}：${body 去头后 400 字}` , agent: "user"}`。语义诚实：note 即用户明示记住的观测；sidecar /distill 契约零改动（kind 仍是 observation）。新状态列 `note_cursor`（distill_state 表加列，幂等迁移随启动）。写回 cursor 用 note 页 updated_at（同 handoff_cursor 字符串游标形状）。

## D3 u/ 根 project 发现

fallbackScan 对 `u-` 根改走页索引发现 project（db 增 `distinctProjects()`——`SELECT DISTINCT project FROM pages`），不依赖 observations。预算护栏照旧：per-root 日预算 + FALLBACK_BUDGET_RESERVE 先包活跃 d/ 根；人根页量级（notes 个位数~十位数）单次蒸馏 token 远低于包根。

## D4 /digest 内部 deadline

http.ts /digest 的 embed 包装（现 30s abort）改双层：deadline（`min(3500ms, caller 预算余量)`）内未回即 throw → hybridCandidates 既有 keyword 兜底接住 + model_note。/digest 总耗时从此有上界（≈ deadline + 关键词检索毫秒级 + 渲染），cell 5s AbortController 下 digest 档必中。加一行 info 日志：`[digest] <rootKey>:<project> rung=vector|keyword notes=<n> items=<n> ms=<t>`（命中率先天可观测；rootKey 仅服务端日志，不出协议）。

## D5 eval 老.note 深度场景

fixtures 增 ≥2 场景：expected_background 全部取自同 project 排名 >3 的旧 note（sanitize 同纪律）；harness 对该场景种子根先跑真实蒸馏（侧车 /distill 同契约调用，embed lane 在时顺带 vectorize），再渲染 digest——与「不蒸馏直渲染」对照（新臂 `digest-distill`，或同臂前置开关 `EVAL_PREP_DISTILL=1`）。门槛不放松：蒸馏臂对 none 的 re_derivation avg diff ≥0.5、win/noninferior ≥70%；且老.note 场景子集蒸馏臂 MUST 优于现 digest 臂（背景可达性差值 ≥1 分均值）。结果入 continue-baseline。

## D6 隐私与预算

人根内容进 LLM 车道与 d/ 根同车道同服务（现状已在蒸馏包根内容）；`FD_MEMORY_DISTILL_U=0` 部署级一键关；per-owner 日预算（400k 默认）对人根生效，超限即停次日续——与既有调度需求同纪律。台账记观察项：人根蒸馏 token 用量、L2 产出率、老.note 召回首例。

## D7 出片与验收

fd-memory 单端出片滚产；真机验收：aloadtree 根（9 notes 39 handoffs，最厚人根）等一个 fallback 周期眼见 `distill` 日志行与 L2 页落地，/digest 老.note 召回眼见；`FD_MEMORY_DISTILL_U=0` 灰度一轮零蒸馏行为。drill 残留零（蒸馏为只读转换+L2 追加，无生产写污染面）。
