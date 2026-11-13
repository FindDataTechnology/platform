## 1. 授权记账（行为不变红线内）

- [x] 1.1 在 `server/fleet-event-wake.js` 唤醒任务创建处写入 mandate（strength/basis.via/策略版本戳/触发引用），策略版本=配置摘要 hash（D2），hash 输入字段清单单点声明；验证：命中边唤醒构造用例，任务记录含 mandate 且既有字段逐字节不变
- [x] 1.2 回合重试沿用原 mandate 原值（不改写路径不存在）；验证：重试用例断言 mandate 与策略戳前后一致
- [x] 1.3 单测：现行全部唤醒场景（命中/未命中/守卫/cap）在改动前后行为逐字节一致（对照既有事件唤醒测试基线）

## 2. 入站去向账 disposition

- [x] 2.1 在 `server/fleet-events.js` 增入站侧去向类别（admitted/filtered/would-accept/cap-refused + 结构化 reason code），经 O1 事件通道单写者接入；验证：单测断言每类触发各产生一条去向记录
- [x] 2.2 每 bot 有界环落盘（默认 200、env 可调，超限翻转最旧）；写入异步化且失败只降级观测不阻断入站；验证：单测环翻转 + 写入失败注入用例入站照常
- [x] 2.3 cap 超限留痕并入统一去向账（cap-refused），保留既有 O1 如实留痕；验证：超限构造用例两条记录同框

## 3. 准入表 + observe 影子档

- [x] 3.1 bot 信号源策略段增加准入表（接收范围×发送者身份×是否点名→explicit/inferred/忽略），默认值=现行行为编码（D6）；验证：默认表单测与现行唤醒判定逐字节一致
- [x] 3.2 放量档 off/observe/auto 与策略版本戳联动（变更即新戳）；off 保持现状；observe 对默认表下被忽略的 inferred 候选做确定性研判（点名/名单/边匹配，D4）只记 would-accept 不建回合；验证：三档各一构造用例
- [x] 3.3 准入表/放量档变更不撤销在途 mandate；验证：收紧构造用例在途回合照常执行

## 4. 授权三操作与恢复重校验

- [x] 4.1 恢复前重校验：挂起回合恢复时按当前策略重校验 mandate（hash 比对+档位条件），失败不恢复且消息按未命中留痕；验证：重校验失败构造用例
- [x] 4.2 策略版本变更通知受影响的在途回合（复用事件通道，不撤销授权）；验证：改表构造用例在途回合收到通知且照常执行
- [x] 4.3 auto 档：仅主人明示开启且该源有显式接受规则时生效，否则按 observe 处理并如实提示；验证：缺规则构造用例

## 5. worker 池人优先槽位

- [x] 5.1 `server/worker-slots.js` 增加 cap 外常备 1 槽（仅人的消息/状态查询可用，新启动永不占用，唤醒优先于新启动，D5）；验证：满载人唤醒用额外槽/新启动排队/cap 0 休眠三用例
- [x] 5.2 TASK_WORKER_MAX=0 时规则零扰动；验证：既有 worker-pool 测试基线全绿不改一行断言

## 6. 收口验证

- [x] 6.1 `openspec validate add-turn-mandate-lane --strict` 绿 + 全量单测绿（368/369 文件 3364/3365 tests：唯一红 test-plaza-browser=打生产站的浏览器验收、并行会话在途区、与本案零交集；test-supervisor-ports 为在册环境挂点已排除）
- [ ] 6.2 真机走查：名单内命中唤醒（mandate 在账）、observe would-accept 记录、cap 拒绝双账同框、人优先槽满载眼见（四条证据留痕）
