## 1. 可写根修复（代码）

- [x] 1.1 `agent-runner/manager.js` spawnSpec.cwd 改为 `spec.dataDir ?? config.cwd`（约 :624），注释写明双解析路径收敛依据；验证：`node agent-runner/test/workspace.test.mjs` 扩展用例——声明 workspace 的 spawnSpec.cwd 断言等于 dataDir、无声明断言等于 config.cwd（字节等价）
- [x] 1.2 本地真 dsh 彩排脚本（沿 `scripts/probe-*` 模式）：起一个 workspace 声明的 child，a2a 回合令其向 `AGENT_DATA_DIR` 写测试文件并回读——写内成功、写 `/app` 树仍拒；验证：脚本退出码 0 且输出三个断言结果
- [x] 1.3 全量回归：`agent-runner/test/*.test.mjs` 与 `node --test agent-runner`（如仓内 runner 单测入口）全绿；彩排后 `pkill -9 'bin/dsh --profile'` 清 dsh 残留（机器卡顿纪律）

## 2. 镜像通道

- [x] 2.1 主 `Dockerfile` runtime 阶段补 `COPY --from=builder /app/agent-runner ./agent-runner`（放 dsh-profile-template 之后）；已落盘（:208；注释不含内部主机名）。验证改挂 3.1——本机无 docker 可用，镜像内容验证（`ls /app/agent-runner/index.js`）随 3.1 GHA 构建产物的一次性容器一并执行
- [x] 2.2 开源快照 Dockerfile 同步同一 COPY（:205）；验证：diff 两文件 agent-runner 行逐字一致 ✓（快照产物由 make-public-snapshot 再生成时自动携带）
- [x] 2.3 repo `agent-runner/docker-compose.yml` 更新为生产实况：image 默认 ccr yizuo/platform、volume `agent-runner-data:/data`、端口段 8790-8850 经 `AGENT_RUNNER_BIND_IP`（生产=尾网 IP）、env_file/command 保持、迁移注记含「勿设 DSH_MATRIX_OVERRIDE」；验证：文件与 design 迁移节逐项对应 ✓；另同步 make-public-snapshot.mjs 的 SCRUBS 表（compose 旧 4 条规则→新 3 条）并本地按「先洗后查」模拟跑通（无 FORBIDDEN 残留）

## 3. cheap-1 重锚（单窗）

- [x] 3.1 窗口前（ALL GREEN，2026-10-06）：GHA 构建 sha-4626911（含 A+B 全码）+ sha-b5f920f（lint 收尾）双双 success；tcr-relay 回灌 ccr 经 `skopeo list-tags` 实查两 tag 均在位（cheap-3 用 `/etc/tcr-relay/env` 的 TCR_USER/TCR_PASS）；cheap-1 一次性容器验证：**matrix gate = pass**（镜像 /opt/dsh 与冻结锁一致，无需 OVERRIDE）、`/app/agent-runner/{index,compose}.js` 在位（2.1 缓验补齐）、dsh bin 在位；镜像已在 cheap-1 预拉（窗口提速）；在役清单=4（spider-heal 8799 r/v6、fingpt 8793 w/v1、vz-agent 8803 w/v1、daas-analyst 8808 r/v2，children=2 budget 192/3072MB）；**spider-heal 节奏=30m 自我回合**（runner 日志实数），窗口避开其回合在途即可（health 显示 resident=空闲）
- [x] 3.2 窗口内（2026-10-06 18:2x，全绿）：stop 旧容器并 rename `agent-runner-dsh-old`（保留）→ 按 2.3 compose 起新容器（4 token 值从 `/opt/agent-runner-stage/agent-runner.env` 与 `.backend-token` 照抄，不落任何文档）→ 起服后确认 poll 拉齐 4 个在役 agent、`/health` 200、meter.jsonl 续写。实况：matrix 门 pass、4 agent 监听、fleet 上报活；**途中修一坑**：旧 /app bind 持久着 llm-providers.json（finddata 路由真件），新镜像 /app 无此运行时状态——已迁入 volume 并以 LLM_PROVIDERS_STORE 指认；另发现 `.backend-token` 文件与容器 env 值哈希不一致（陈旧漂移，文档早有预警），验收改从容器 env 取值
- [x] 3.3 活链验收（PASS）：对 `packs-yopqIgU6vZhFNGpGWvUWbw-daas-analyst` 发 a2a 任务「把测试文本写入我工作区 data 目录并回读」——产物出现在 `/data/packs-yopqIgU6vZhFNGpGWvUWbw-daas-analyst/data/` 且回复含回读内容；失败则执行回滚（start agent-runner-dsh-old）。实况 PASS：agent 回执「沙箱 workspace-write 下 $AGENT_DATA_DIR 写入未被拒」+ `printf 22 字节 / od -c 回读一致`；独立复核落盘 `/data/.../data/write-probe.txt`=DATA-WS-PROBE-20261006；meter 记到该回合（15.2s ok）；回滚位 agent-runner-dsh-old 保留（Exited 0）
- [ ] 3.4 善后：验收 24h 后清 `/opt/agent-runner-stage` 代码目录（.bak 系列再留一个周期）；旧容器删除

## 4. 收口

- [x] 4.1 finddata `MCP-REGISTRY.md` §3「daas 工作区沙箱」挂账行已销（新文本含修复口径与活链验收）；归档件 closeout report 追记「销账追记」节已落盘 ✓
- [x] 4.2 DEPLOY.md 新增「生产 runner 重锚平台镜像」实录节（含重放清单/回滚/验收与 .backend-token 漂移注记）+ 6.2 节历史形态注改；`docs/adr/0018-production-runner-ships-in-the-platform-image.md` 已落盘 ✓
- [x] 4.3 归档（本提交）：spec 增量并入 `openspec/specs/agent-runner`，change 移入 archive/2026-10-06-
