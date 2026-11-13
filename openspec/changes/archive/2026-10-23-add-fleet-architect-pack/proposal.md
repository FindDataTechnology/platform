# Proposal: add-fleet-architect-pack

## Why

编排路线(explore 底稿 `docs/fleet-orchestration-scale-explore.md` §八)的 L4 自然语言驾驶面:客户要在壹座聊天里「说一句话组建/修改一支舰队」并持续迭代。机制面上三段已备——舰队写 API 全套(ownerGate)、模板预校验、O1 回合事件读面(`add-fleet-turn-events`,已实施待出片)——缺的是把它们接进对话的那双手:一个持有舰队读写工具的架构师角色 + 走完「起草 → 呈 diff → 批准 → 落地」纪律的对话面。本 change 是 Phase 1 第二轨的**原型**:仅支持现行 schedule 模式的舰队结构(建/改/停/删岗、节奏、组织树),代数(supervisor/pipeline/自定义图)到位后同一工具面自然解锁。

## What Changes

- **架构师 MCP 工具面**:新本地 MCP 子进程 `server/fleet-architect-mcp.js`(`mcp.json` 注册,delegation/cron 同款),五个工具:
  - `fleet_list` — 名下列出 owner 全部舰队(状态/岗数/健康概要);
  - `fleet_spec_read` — 单舰队完整 spec(岗位树、target、节奏、模型声明);
  - `fleet_draft` — 提交**草稿**(新建舰队或既有舰队的成员操作集),服务端 dry-run 校验(岗 shape、cron 可解析、目标存在、唯一岗、树无环、span 预算),返回结构化校验结果 + 归一化 diff + 成本预估;**不落库**;
  - `fleet_apply` — 执行一份草稿;apply 时**重校验**(状态漂移如实报错),写面走既有舰队写路径(单写者纪律不破);
  - `fleet_turns_read` — O1 回合事件读(舰队级 status/source 过滤)——「谁在失败」的读态动词,数据源即 O1 端点,无第二份。
- **回环桥**:`/api/fleet-architect/*` loopback-only(auth.js 豁免,delegation 桥同款);身份服务端解析为 **cell owner**(壹座单用户 cell,架构师是用户的代理)。
- **成本预估器**:纯函数——从草稿算每岗 turns/day 与舰队 tokens/month 区间(区间宽度来自 env 假设,默认 3k–8k tokens/回合);凡「新增 >5 岗或含新 cron 节奏」的草稿,校验结果**必含**预估(Q6 决议)。钱不估(无价格源),以 token 量纲呈区间。
- **官方种子**:`docs/fleet-architect.seed.json`(pack 清单一枚 agent:架构师 persona,系统提示钉死编译纪律——diff 必呈、批准才写、未知范式用原语逼近画图、永不自由发挥),守恒测试钉住其通过 pack 清单校验。铸造上架随出片列车(与舰队种子同配方)。
- **驾驶舱/前端零改动**:架构师是聊天面,不碰驾驶舱。

## Capabilities

### New Capabilities

- `agent-fleet-architect`: 壹座聊天内的舰队自然语言编排面——架构师工具面(五工具,读/草/写分离)、草稿 dry-run 校验与成本预估、批准纪律、读态复用 O1/cockpit 既有读面。

### Modified Capabilities

(无——ADDED-only 新能力面,与在途 `add-fleet-post-model`/`add-fleet-turn-events` 的 delta 无交叠)

## Impact

- **代码**:`mcp.json`(一条注册)、`server/auth.js`(loopback 豁免)、新 `server/fleet-architect-mcp.js`(thin 客户端)+ `server/fleet-architect.js`(桥路由 + dry-run 校验组合 + 预估器纯函数)、`server.js`(桥 wiring)。校验组合**复用既有纯件**(cronParser/`findPostByTarget`/目标解析),不重构 `routes/fleets.js`。
- **已知边界(如实记)**:dsh 无 per-preset 工具白名单(bots v1 posture 同款事实),架构师工具面随 mcp.json 对全部 persona 可见;纪律由架构师 persona 提示词 + 工具描述钉住,写面 owner 作用域兜底。这是平台现状约束,不是本 change 引入的放权。
- **测试**:新增 `scripts/test-fleet-architect.mjs`(纯核注入式):草稿校验矩阵(过/拒/警告)、预估器区间、apply 重校验与漂移报错、桥 owner 身份、读态端点复用;既有舰队套件回归零新增红。
- **出片**:server/ 与 mcp.json 有改动,需镜像出片——**与 add-fleet-turn-events、post-model 归档终验攒同一列车**(用户已定攒车)。
- **非目标**:不做代数/模式声明(O3/O4);不做实时指挥、不做运行时暂停以外的操作动词;不做结构化批准工具(批准是对话级,apply 重校验兜底);不做钱币计价;不改驾驶舱。
