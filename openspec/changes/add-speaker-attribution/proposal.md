## Why

会议录音现在能被采集成**一条按时间排列的文本线**（`add-voice-capture-lane`），但这条线不知道
每句话是谁说的。房间里的路由因此只能靠显式 `@`，或者按文本意图猜——而"猜"在多人会议里正是
最贵的一种错：同一句「预算怎么样」可能同时匹配三个可调用团队，或者被送给不该听的人。

原始需求里「识别不同人的语音，并智能地调用不同的 agent」这一半至今没有落地：前一件在
proposal 里明确写了「说话人分离不在本件（`add-speaker-attribution`）」「按人路由（再下一件）」，
而这两件都从未立过。

现在做，是因为**消费侧已经建好了**：`gateway/zhiyu/voice-router.js` 早已把
`mention > attribution > intent` 排成优先级，`ATTRIBUTION_CERTAIN = ["session","bound"]`，
并且规定「不确定的归属一律落 `needs_confirmation`，绝不猜」。缺的只有 `attribution` 的**生产者**——
今天没有任何东西能填出这个信号。

## What Changes

- 转写入口可按需请求**分段说话人标签**（`POST /api/voice/transcriptions` 的响应从「只有 `text`」
  扩展为可带 `segments[]`，每段含起止偏移与说话人标识）。**默认不改变今天的行为**：不请求即
  逐字节同今天；上游不支持 diarization 时退化为「单一未知说话人」，产物仍是那条文本线。
- 归并产物从「一行文本」升级为「按段可读、每段带说话人标识」的同一份文档：导出与入房两条
  消费者都不必改协议，说话人只作为附加标注；没有标签时渲染与今天一致。
- 新增**身份归属**：把说话人落到一个具体的人。**只允许两个来源**——
  (a) 本场会话内的显式声明（「我是张三」/ 入会时选定身份），(b) 已知的席位绑定
  （这个人就是这台席位的主人）。**声纹永不参与身份判定，也永不作为认证因子**（既有裁决）。
- **主路是「按流归属」而非「从混音里分离」**：实测（design 附录 A）证明词元车道今天既无
  diarization 也无分段，所以归属由**采集流的来源**直接给出（每路采集 = 一个人）。这既不需要
  上游新能力，也比任何分离算法更可信——它没有推断成分。混录（一支麦）场景如实落「待确认」。
- 归属结果带确定性等级（`session` / `bound` / `inferred` / `anonymous`），并直接喂给
  `voice-router` 既有的 `attribution` 信号：`session`/`bound` 可走默认接收方；
  `inferred`/`anonymous` 一律 `needs_confirmation`，由人一键确认。
- 归属**只作路由信号**，不进任何权限、计费或可见性判定。

## Capabilities

### New Capabilities

- `speaker-attribution`: 会议录音的分段说话人标签与身份归属——标签的请求与透传、拿不到时的
  逐字节降级、归属的两个合法来源与确定性等级、以及「不确定即确认、绝不再猜」的约束。

### Modified Capabilities

- `voice-lane`: 转写转发的契约扩展——`/api/voice/transcriptions` 可选返回分段说话人标签，
  其余（固定 OpenAI 兼容协议、凭据跟随模型车道且永不下发浏览器、25 MB → 413）不变。

## Impact

- **代码**：`server/routes/voice.js`（转写响应形状与 `response_format` 选择）、会议录音的归并
  与入房路径（携带分段说话人）、`gateway/zhiyu/voice-router.js`（消费 `inferred`/`anonymous`
  的确定性等级；路由优先级本身不改）、web / 小程序 / App 的转写渲染（说话人标注与确认交互）。
- **接口**：`/api/voice/transcriptions` 增加可选字段（向后兼容：缺省即今天）；内部采集
  session 的分段结构扩展。
- **数据**：分段表增加说话人列（可空 = 未知）；无迁移风险，空值即旧行为。
- **依赖**：上游词元语音车道是否支持 diarization 需实测确认；不支持时本件仍可交付
  （降级路径成立），但"按人路由"的价值要等上游具备才能兑现——这一点必须在 design 里说清，
  不能让实现假装有标签。
- **UI 文案**：新增说话人确认相关字符串，须走五个 locale 文件。
