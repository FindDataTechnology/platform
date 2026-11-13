## Context

- 骨架全部现成：`skill-self-evolution` 的候选 store/提议工具/评测门/晋升路由（11/13，剩真机走查+成本核对）；`memory-eval` harness（隔离 scratch root、同模型同温、judge 盲评、臂匿名）；blueprint 双钥匙纪律；fleet 自迭代防中毒四闸与模型漂移毒化教训（`ctx.session.model` 早退失效类漂移）；`add-agent-fork-lineage` 的 fork 端点（9/9 已实施）。
- persona 注入汇合点：execution 侧唯一汇合点（fleet-context-injection-seam 归档建制）；custom preset persona 经 dsh-profile 写入 cell 会话。
- 落位面：`add-agent-builder-hub` 调优区已预留 persona 修订占位（空态契约已写定）。
- 用户裁定：persona 桶自调优立项（2026-11-01 explore 会话）。

## Goals / Non-Goals

**Goals**：角色桶镜像技能桶的完整闭环；晋升分流（自建预设物化 vs pack→fork）；会话人格稳定边界。

**Non-Goals**：不做 fleet 岗位（posts）级修订（`agent-self-iteration` 管团队层）；不做技能/工具桶修订（各归其道）；不做机翻/自动合入；不做修订 diff 的语义自动评级（judge 只判任务表现）。

## Decisions

### D1: 完全镜像 skill-self-evolution 的四段结构（提议→门→晋升→lineage）
新表 `persona_candidates` 与 `skill_candidates` 同构不同表；工具 `persona_amend` 与 `skill_propose` 同法注册（无执行语义）。
- **为什么**：同一批纪律（预算门、debounce、上限、双钥匙）已实证，镜像实现成本最低、评审心智一致。
- **备选**：合并一张通用候选表（拒：评测臂形状与晋升分流完全不同，多态表徒增复杂）。

### D2: persona 臂=整套 persona 文本注入差异，复用技能臂装配器的 harness 挂点
评测时臂 A=现行 persona、臂 B=修订 persona，其余（模型、温度、场景任务、scratch root）全同；judge 盲评任务产出。
- **为什么**：persona 的效果只能经任务表现观测，单测 persona 文本相似度无意义；harness 纪律（隔离、匿名）现成。
- **备选**：LLM 直接评 persona 文本优劣（拒：文风偏好不可比、且违反「评测是证据」的证据形态纪律）。

### D3: pack persona 的接受动作=开 fork 草稿，不碰 pack 本体
pack 已发布版本不可变（`pack-marketplace` 既律）；fork-lineage 端点是唯一合法衍生路径。
- **为什么**：跨 owner 写入零可能（边界既律）；fork 草稿进我的创作后走正常发布流，溯源天然清晰。
- **备选**：接受后自动发布新版本（拒：绕发布门与版本不可变既律）。

### D4: 生效节奏=preset 物化既有节奏，不发明热载
persona 写在 cell 会话铸造时；进行中/parked 会话 persona 不热改。
- **为什么**：模型漂移毒化教训的镜像——会话中人格被 out-of-band 切走就是漂移；「人格稳定」是会话内不变式。
- **备选**：下回合热载（拒：回合间人格漂移，且注入缝的 persona 段按会话固化）。

### D5: 防中毒闸复用 fleet 自迭代的注入类检查
修订文本过既有注入闸（提示注入模式扫描）；证据链要求来源回合可溯。
- **为什么**：候选文本未来会变成系统提示的一部分，是最高价值的注入靶；闸已建制，复用即零新面。

## Risks / Trade-offs

- [`skill-self-evolution` 剩余任务（真机走查/成本核对）未完即并行本单] → 本单评测 A/B 的 token 账目核对与 ④.4 同班做（两单共用 judge-lane 车道）；其结论反向喂本单预算参数。
- [persona 臂评测的场景任务从哪来] → 提议证据里的来源回合即场景种子（同 skill 版）；场景不可构造时候选如实「未评测」。
- [修订把 persona 越改越保守（judge 偏好平均化）] → 门判据要求「差异可解释」，驳回理由留审计；lineage 可回退兜底。
- [`add-agent-builder-hub` 未上时评审面无处落] → 评审 API 先行，面落 hub 调优区；hub 未上前暂以现有技能候选区同构挂点过渡（两单任务表对表）。

## Migration Plan

1. 依赖次序：`add-skill-self-evolution` 收尾（harness 实证）→ 本单表/工具/路由 → 评测臂装配 → 评审面（hub 调优区）。
2. 出片：server 与前端可同班；无数据迁移风险（新表 additive）。
3. 回滚：镜像回滚即回滚；候选表数据保留无害。

## Open Questions

- persona 臂评测的 judge 模型是否与技能臂同选（minimax-m3.1-flash 级）——随 4.x 真机班定，不影响契约。
