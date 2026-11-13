# Tasks: add-local-fleet-control-plane

## 1. 先行 spike：链印证（go/no-go 闸）

- [x] 1.1 零改动起 agent-runner（本机 dev），手工写一个静态假 feed（`/api/agents` 分页 + card + skill body，形状照 `agent-runner/registry.js` 消费侧抄），把 `AGENT_SERVING_REGISTRY_URL` 指过去，验证「编目→分片→拉起→/health 五态」全链；产出形状样张（金样 JSON）存档 —— **GO**，证据见 `spike/README.md`（golden-agents.json / health.json / runner.log / feed.log / crash-excerpt.txt），假 feed 落 `scripts/spike-local-feed.mjs`
- [x] 1.2 闸点评审：runner 若需任何代码改动才能吃本机 feed，回 design.md 修 D1/D2 再继续；若调通了，金样即 feed 合同测试的基准 —— **零改动调通**，D1/D2 不动；金样作合同基准
- [x] 1.3 顺带核实 `AGENT_RUNNER_MAX_CHILDREN` 在 pod 密度下的真实计数口径（child vs pod），把结论写进部署门实现注释 —— **实测为 child 进程数**（pod 同包共宿 1 个），已回改 spec/design 的容量口径为「运行时组」

## 2. cell：本地 roster feed

- [x] 2.1 `db.js` 迁移：`local_fleet_deployments` 表（agent_path 主键 + pack_id/agent_id/enabled/config_overrides/时戳），幂等；单测覆盖建表与字段
- [x] 2.2 条目合成读/写共用 —— **无需抽取**：`composeDescriptor`/`composeAgentCard`/`listServingAgents` 本就是 export，feed 直接复用（云 deploy 路径与本地 feed 同一合成函数，漂移在源头被杀死）；既有 agent-serving 测试全绿
- [x] 2.3 新 `server/local-agent-feed.js`：`GET /api/agents`（limit/offset/total_count/has_next 形状与 runner 客户端语义逐字段对齐）+ card + skill body 端点；Bearer 校验 `WANXING_LOCAL_FEED_TOKEN`；只绑 127.0.0.1；孤儿剔除（pack 已卸载的部署记录不透出）；停用（enabled=0）摘除但保身份；单测含分页/401/摘除/复现身份稳定
- [x] 2.4 first-run bootstrap 幂等 mint `WANXING_LOCAL_FEED_TOKEN`（与 seat id 同批）；既有安装升级时补铸不重置

## 3. cell：部署写面

- [x] 3.1 `server/routes/wanxing-fleet.js` 增 deploy/stop/start/remove 端点，标准 cell 鉴权；三闸（可部署性/幂等/容量 409 `capacity_exceeded`）；写后只报落库事实；单测三闸全开
- [x] 3.2 catalog 端点默认切本机 feed（外部 registry 凭据存在时保留公网只读桥切换）；read face 既有降级语义不动；卸载 pack 摘除联动走既有 uninstall 钩子（孤儿不留）
- [x] 3.3 `supervisor/descriptors.js`：`wanxingEnabled && !AGENT_SERVING_REGISTRY_URL` 时注入本机 feed 地址+令牌；外部配置存在时逐字节不变（对比测试钉死）

## 4. web：FleetPage 写面

- [x] 4.1 目录区部署入口解锁，动作走 3.1 写面；「本机集群（可写）/ 云席位（只读桥）」分区渲染，未配对时云席区呈引导而非禁用本机区；i18n 五语言 key 同批补齐（locale 闸纪律）
- [x] 4.2 容量错误呈现为「已用/上限 + 卸载腾出」引导；写后 live 端点随行刷新（轮询既有行），不允许假绿；启停身份稳定的 UI 断言

## 5. 合同与双平台见证

- [x] 5.1 feed 合同测试：`scripts/test-local-agent-feed.mjs` 5.1 以 `spike/golden-agents.json` 逐字段钉住消费面；runner 侧真件冒烟见 1.1（真 runner + 本机 feed 走通编目→listener→五态）
- [x] 5.2 写面→feed→runner 客户端节拍合同：`scripts/test-local-agent-feed.mjs` 5.2 用 agent-runner 自己的 registry 客户端吃本机 feed（部署→领回→停用→摘除→启用→复现），杜绝「写成功不可见」
- [ ] 5.3 乘 `automate-nonweb-acceptance` 的 installer-e2e 轨加本地集群一幕（装离线样例包〔借 `add-offline-pack-supply` 的 bundle，若其未落地则先用仓库内置样例包〕→部署→live 见 agents→断公网仍工作→卸载收净）：windows 默认腿跑绿 + mac dispatch 腿跑绿，证据进台账 `docs/registry-maintenance.md`
- [x] 5.4 `openspec validate add-local-fleet-control-plane --strict` 绿；本批新增 44 例测试全绿（本地 feed 13 / 离线 bundle 9+6 / 常驻 8 / 预装 6 / child 死亡 3），pack/market/registry/serving 回归全绿（两处 HEAD 既有红已归因为并行会话在途，非本批引入）。桌面快照已出（v1.3.24，池仓 `testaction005/build-pool` 侧分支 `desktop-release/v1.3.24`）；**人工肉眼走查（含截图过目）仍挂账**——本会话模型不支持图像输入，DOM 级 e2e 已覆盖四种交互形态
- [x] 5.5 **F3 根因已修**（commit bd5a085f）：harness/dsh.js 的 turn() 先建 collected Promise 再 await prompt()，child 在 prompt 在途时死亡 → pump 的 _child_exit 分支 reject 时无人挂 handler → Node 判 unhandled rejection → 整个 runner 退出（本地集群全体 agent 陪葬）。修法三处：collected 立即挂 no-op catch、prompt 与 collected 竞速（child 已死时回合不陪挂）、settle 幂等（activeTurns 只减一次）。单测栈与现场摘录逐帧一致，去掉修复必红；真机 SIGKILL 复核：调用方拿到 -32002、runner 存活
