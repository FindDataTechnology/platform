# 走查班挂账交接清单（2026-11-04）

> 出处：§15.128 待办盘点 → §15.129–132 走查班清偿。本清单=走查班**没能在本会话收口**的精确挂账，按「谁/什么触发条件能做」分四组。
> 现场（11-04 20:40 核）：persona 单 14/14、skill-evo 单 13/13（**两单全勾，只差归档搬运**）；tool-desc 差 4.1；外聊车道差自身实现。生产 pod Running/ready（restarts=6 为走查唤醒旧账，近窗无新崩溃）。

## A. 静窗可做 —— paas 走查尾款（配方就绪，不依赖别人）

### A1. tool-desc 4.1：同一任务增强开/关双真回合 + D2 活体演练
- **已测**（§15.131，勿重做）：全量面 594 工具附加 80513 字符（≈23k token 上限；588 源 finddata-supply-annotations + 6 catalog；单 brief 最长 294 字）；per-回合实测 +805 in（builder 班）；工具调用成功率增强面活体已见。
- **还缺**：①同一任务 ON/OFF 双真回合对照（成功率/token 增量/描述长度三列同框）；②D2 单点预案**活体**翻一遍（关开关→overlay 清件→面逐字节回原）。
- **配方**：需要一个「注册面里带 canonical brief 的 MCP server」的轻载 cell。demo 注册面（actions/persona-evolution 等 8 server）全无 brief → agent 路由 bash → 空转。做法=在 demo 装一个带 brief 的 server（如 eco-mcp-fetch，需车道凭据）或用一个已装 fd-quant/eco-* 且可唤醒的 cell。开关=`PUT /api/preferences {key:"tool.description.enrichment", value:false}`（门读位 `agent-session.js:920/945`），改后**必须切 preset 触发 writeMcpPatch 重组装**才生效（本会话 demo 子进程 preset-switch 撞重启守卫没切成——静窗趁 cell 空闲时切）。
- **阻因备忘**：生产唯一有效面 1da519d4 被 B 线（见 C）OOM 阻。

### A2. skill-evo supersedes lineage 可见
- **已测**（§15.132）：无 supersedes 候选全链绿（真回合→skill_propose→A/B candidate best→promote→名册 status=user 在册）。
- **还缺**：一个**带 `supersedes`** 的候选（改进既有 USER 技能）→ 三臂评测（control/old/candidate）→ promote → 评审面 lineage 可见。
- **配方**：先 promote 一个基础技能（A2 已产 customer-feedback-triage 在 demo 名册），再真回合提一个 supersedes 它的候选。demo emptyDir，重启即清，静窗现做现验。

### A3. persona 4.2 第六环：完整绿链（过门→接受→新会话 persona 生效）
- **已测**（§15.130）：五环眼见+三闸活体（不劣于门拦过保守修订/promote 409 双钥匙/debounce 429）。
- **还缺**：一版**真正更优**的修订自然过门 → promote 物化 → 新铸会话 persona 生效眼见。
- **配方**：demo 上现做（同 A2 节奏）。§15.130 成本直测里那版校准修订（「不受污染的结论照常交付 + 矛盾行标待核」）judge 实测判**乙胜**——直接用它 propose（同靶 24h debounce，换靶 preset 即可）→ A/B 应绿 → promote → 新回合问 agent 复述人格首句验生效。

### A4. 归档搬运（两单已全勾，非走查是账）
- persona 单（14/14）、skill-evo 单（13/13）可走 sync 主 spec → `openspec validate --specs` → archive。沿归档窗口纪律，勿与出片抢窗。

## B. 待出片 —— fix-external-team-chat-lane（自身实现未上产，非纯尾款）

外聊车道 5 项未勾，**前置=本 change 代码上产**：
- 2.4 端到端：生产对话前台拿名单后派发成功、目标岗位起轮、turns 0→非 0。
- 3.3 对外产品介绍 pack 声明 `publicFacing:true` 重铸上架（种子已加，待出片后铸）。
- 4.2 复测访客侧不可见 `<thinking>`（待出片后真机复测）。
- 6.2/6.3 主 spec 同步+归档+台账（收尾）。
> 归该线自己的出片班驱动，走查班不代跑。

## C. 用户拍板 —— B 线：cell 内存结构性超卖（A1/A3 生产路径的根阻）

- **铁证**：1da519d4 cell RSS 名义 1598MB > 1536Mi 限（§15.125）；本会话唤醒它连撞 6 次 OOMKill（cgroup killer 挑中唤醒窗的进程）。
- **两候选**（§15.125 在册）：①提限（memory limit 上调）②拓扑瘦身（卫星链归组/驻留驱逐）。
- **数据已备**：驻留闸 `last_gate_refusal_json` 拒绝证据、`/api/monitoring/memory` 水位面（五语运维坞卡）在产——拍板前可先攒一段闸拒绝率回看。
- **影响**：不定这条，A1/A3 只能永远在 demo/轻载面做，生产大 cell 的走查重腿都悬。

## D. 另一条线（flag，非本班）

- `fd-open-data-mcp` 新 pod ImagePullBackOff（sha-240f720 拉不到）——11-04 走查期间 observed，属该服务自己的出片/镜像线，请对应会话核 tag 是否已推仓。

---
*执行顺序建议：静窗先扫 A3→A2→A1（同一条 demo 链上顺手做完，一次唤醒一次评测），A4 归档随下一归档窗；C 是决策不是活，越早拍越好。*
