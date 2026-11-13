# Tasks: add-spider-heal-pack

## 1. pack 内容与脚本

- [x] 1.1 撰写 manifest（人格+三技能+serving 契约 rhythm 30m/budget 20m），本地 `lib/pack-manifest.js` 校验零错。验证：`node -e` 校验脚本输出 `[]` ——persona 811 字/三技能(987+2075+511)/rhythm 30m/budget 20m，validatePackManifest 零错
- [x] 1.2 `scripts/spider-heal-pack.mjs`：publish（幂等）+ `--deploy`（billing/secrets/notifyChannel/budget 覆盖）。验证：本地 `--help` + manifest 校验路径单测式自查 ——发布 v1+部署实测通过（buildManifest 可导出复用）

## 2. 部署与冒烟

- [x] 2.1 fd-prod 发布 v1 并部署（萬星运营号，private，无 PAT 降级形态）。验证：registry 条目+runner 起服（cheap1 日志 serving packs-*-spider-heal） ——pack KkCie7NlrHluo4LiKPnn0w v1，runner :8799 起服，健康刷新 healthy
- [x] 2.2 门面冒烟：调用键 SUBMIT 假工单→回执入队（凭据未配置→转人工）；同单重放去重；STATUS 查询。验证：探针/ curl 留档 ——SUBMIT→凭据缺失按协议终态 manual+结构化回执；重放同果；STATUS 跨回合读 inbox（state=manual/retry=0/note 完整）
- [x] 2.3 rhythm burn-in：meter.jsonl 落 `kind:self` 行（12:04:52Z，13.8s 空巡检，ok:true）——部署+30m 首巡如期

## 3. 文档与交接

- [x] 3.1 `docs/spider-heal-pack.md`：finddata 契约（SUBMIT/STATUS 协议、PAT 最小权限、secret 名约定 git_pat/gh_actor、部署/升级/回滚、rhythm 与外部触发关系、四类事件）。验证：文段与技能实文一致 验证：docs/spider-heal-pack.md 与技能实文一致
- [x] 3.2 finddata 侧待办清单落档（PAT 签发/工单目录就位/中央库 MCP 注册后追加引用）。验证：文档含清单 ——PAT 签发/工单流/中央库 MCP/试运行四项

## 4. 追记（2026-10-03 晚 —— PAT 绑定与 v2 实跑，随 facet cutover 修复）

- [x] 4.1 v2 发布+部署：`git_pat`/`gh_actor` 入库（finddata 待办① 完成）；runner drain 换新 child 实证计费键引用保留（pk_e19083b4…）+ 2 secret 落 child `.credentials.yaml`
- [x] 4.2 门面合成工单实跑：真回合 110s → 终态 `manual`（工单不可读，四路核实）→ 同 Idempotency-Key 重放返回首答（仅 1 笔记账：2 分钟 settled）
- [x] 4.3 cutover 缺口修复（阻塞本任务的根因）：facet store 迁移漏 2 个私有包 + 全部 deployment_keys（已按表回填，两库全表对齐）；facet 部署缺 `SUB2API_ADMIN_KEY`（k8s envFrom 跳过含破折号的键名，GitOps aa60f6f 补 inline secretKeyRef）——否则 facet 侧部署会静默丢弃计费键绑定
- [x] 4.4 通知链路备注：平台滚动窗口内 `bot_notify` 会 503（单次纪律=即丢）；rolling 后 relay 直发复测 `{ok:true}`

## 5. 追记（2026-10-04 —— 运营四项收口 + PAT 轮换，闭环完结）

- [x] 5.1 ① 通道换正式：`fd-ops` 绑在实际在用的会话（平台 bot 名 `test` = 微信里的 qinfa 号，命名坑在册）→ v4 重部署 → relay 审计 `fd-ops|sent` 送达实证
- [x] 5.2 ② 总闸/限流 MCP：自研 shim `servers/fd-health-config` 部署 cheap1 + registry 注册 + pack v3 挂载 `mcpServers:["fd-health-config"]`；全链实证（公网三流程 + runner `1 MCP` + 真回合 `tools/call`，详见 `servers/fd-health-mcp/README.md`）
- [x] 5.3 ③ 模型/计费核验：runner 默认 + child 路由 = `deepseek-v4.1-flash`；部署键（sub2api id 31）183 条用量逐请求实付，与门面调用键结算双账闭环
- [x] 5.4 ④ PAT 轮换：FindDataOfficial 窄授权 v5 上线（gh_actor 同步换官方号）；旧 scs001 宽 PAT 待用户吊销；真修复全链已由结构层演练单实战闭环（PR #1 人审 merge）
- 全程证据与运维配方：`docs/spider-heal-pack.md` 末节 + `servers/fd-health-mcp/README.md`；提交 9b21393/1f8b1c8/bb179e0/6aad212
