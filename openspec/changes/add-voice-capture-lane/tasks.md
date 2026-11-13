## 1. 数据与转发复用

- [x] 1.1 新增 `server/voice-capture.js` 两表（`voice_captures`、`voice_capture_chunks`，后者带 `UNIQUE(capture_id, seq)`），验证=连续启动两次不报错，`PRAGMA table_info` 列出全部列，重复插入同 (capture, seq) 被唯一约束拒绝
- [x] 1.2 把 `server/routes/voice.js` 的转写转发抽成可复用函数（`transcribeBuffer({buffer, mime, filename})`），验证=既有 `voice-lane` 测试全绿，输入框语音的请求体与服务端响应逐字节一致（改动前后抓包对比）
- [x] 1.3 采集端点 `POST /api/voice/captures`、`POST /:id/chunks`、`GET /:id`、`POST /:id/finish`、`POST /:id/abandon`，验证=`scripts/test-voice-capture-chunks.mjs` 覆盖五条路径的成功与错误码
- [x] 1.4 采集端点与输入框语音同口径的不可用拒绝（`voice_disabled` / `voice_not_configured` 503），验证=停用后创建采集返回 503 且不落行

## 2. 分片语义

- [x] 2.1 实现幂等：重复 (capture, seq) 返回既有状态、不重复转写、不重复计费，验证=同片重传两次，usage 记录只有一条、文本不变
- [x] 2.2 实现乱序接受与按 seq 排序，验证=乱序到达用例的归并结果严格按 seq 递增
- [x] 2.3 实现单片失败隔离与单独重试（重试上限默认 2），验证=20 片中 1 片失败时其余 19 片完成；重试只产生 1 次新请求
- [x] 2.4 实现到期与放弃：到期停收分片但文本可读；放弃删音频与文本，验证=两种终态各一条断言，放弃后列表不可见

## 3. 时间轴与归并

- [x] 3.1 记录并校验 `start_ms`（客户端上报、服务端要求单调且与 seq 一致），验证=非单调或与 seq 矛盾的输入被拒并指明原片
- [x] 3.2 实现纯函数 `mergeChunks`（空片跳过、段带 `startMs`、确定性），验证=`scripts/test-voice-capture-merge.mjs` 同一输入两次归并字节一致；静音片不产生空行
- [x] 3.3 边界不吞字不重复：以「一句话跨两片」的固定样本做断言，验证=该句在归并结果中出现且仅出现一次
- [x] 3.4 归并结果人工订正（一次保存、留痕、保留原始归并文本），验证=订正后读面为订正版，`original` 字段仍可读

## 4. 预算与留存

- [x] 4.1 分钟数与金额双闸：触顶停止新片转写但继续暂存分片，验证=`scripts/test-voice-capture-budget.mjs` 两闸各一条；响应带「已转写到第 N 分钟」
- [x] 4.2 暂存保留期（默认 24h）与过期清理（幂等、报条数），验证=过期用例清理一次后第二次清理删除 0 且返回条数为 0
- [x] 4.3 音频转写成功即删（`retainAudioMs=0` 默认），删除失败进重试队列，验证=成功后存储无该片；人为让删除失败时进队列且可重试成功（落地订正见 design.md D6：删除与 `status='done'` 同条 UPDATE，无独立失败分支；可重试的是卡在 `transcribing` 的分片，由清理任务置回 `failed` 并保留音频）

## 5. 面与入房

- [x] 5.1 web 采集面：发起/进度（每片状态）/逐段文本/结束汇总/订正/导出纯文本，验证=组件级用例覆盖四种片状态与订正流程（`scripts/test-voice-capture-web.mjs`：`web/src/lib/capture-api.ts` 行为 + `web/src/components/voice/CaptureSession.tsx` 四条状态/单次订正/确认门/无硬编码中文；四条源码断言已用注入变异证明能红）
- [x] 5.2 「送入房间」需一次确认，落 `kind=event` + `meta.source=capture`，不触发回合路由，验证=入房后房间只多一行、无 agent 回合、无回合配额扣减（`POST /api/voice/captures/:id/room`，`confirm:true` 必需，落 `role=system` + `blocks[0].meta.source=capture`，同采集同房间幂等）
- [x] 5.3 不确认不入房，验证=结束后未确认时房间零新增行（`confirmation_required` 409，用例断言行数未变）
- [x] 5.4 小程序/App 的「发起与上传」最小面（复用 `add-voice-input-mobile` 的分片回调），验证=桩环境下三端走同一份切片+重传实现（同一套用例）（切片/重传/进度/导出全部来自 `packages/core/src/voice-capture-slices.ts`；`scripts/test-voice-capture-mobile.mjs` 10 例 + `scripts/test-voice-capture-slices.mjs` 的三端导入闸）

## 6. 验收

- [ ] 6.1 一小时音频端到端：分片全成功、归并有序、音频零留存，验证=用一段 60 分钟测试音频跑完整链路，产出文本与人工抽听一致（机械半边已自动化：`scripts/test-voice-capture-e2e.mjs` 用 120 片跑完，断言全 done、归并严格 0..119、库里音频 0 行、计费 60 分钟。**人工抽听这一半未完成，且 CI 替代不了**——2026-11-12 复核时从 `[x]` 改回 `[ ]`：勾上时这条自己的注里就写着「人工抽听仍待真人」，勾选与注自相矛盾。CI 能验的是「没崩、顺序对、没留存」；「转出来的字对不对」需要一个知道答案的人，或一份**独立来源的**参考稿。项目里那段 60 分钟音频没有参考稿，拿 ASR 自己的输出当基准＝自己判自己的卷（同一模型的同一偏差会被判绿）。要做成机检只有一条路：人工校订一次存成 `expected.txt`，此后按编辑距离阈值比对——这是新任务，不是这条的剩余部分。在此之前本变更不归档。）
- [x] 6.2 30% 分片失败的网络条件下仍能完成并如实标注，验证=注入失败后补传成功，最终文本完整（36/120 注入失败，补传后文本与期望逐字节相等；另有 6.2b 断言失败片在补传前可点名到 seq 与 errorCode）
- [x] 6.3 `openspec validate add-voice-capture-lane --strict` 绿
