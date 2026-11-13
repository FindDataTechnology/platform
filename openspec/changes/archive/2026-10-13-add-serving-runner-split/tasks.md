## 1. 预备

- [x] 1.1 rsync cheap-1 `agent-runner-data` 卷 → cheap-4 `/data/agent-runner-serving`（103MB 全量；llm-providers.json/按代理 home/meter/notify 齐搬）
- [x] 1.2 kubectl 建 secret `agent-runner-serving-env`（四 token 原样拷，out-of-band）
- [x] 1.3 GitOps `agent-runner-serving.yaml`（cheap-4/hostNetwork/chown init/4Gi Guaranteed/sha-5c9f532/DEFAULT_ID=cheap-1 惰性/预算 3328/上限 8）；连带 compute-quota 抬顶 requests 12→16Gi、limits 24→28Gi（双项顶满，不抬 pod 创建被拒）

## 2. 新 runner 上线（惰性）

- [x] 2.1 pod Running；matrix 门 pass、poll 0 agent 0 child（惰性生效）、cap 8、budgetMb 3328
- [x] 2.2 面板 runner-serving 心跳（headroom 3328 断层第一）；8790 /health 应答；8791-8822 专用无撞口

## 3. 切流（接管波）

- [x] 3.1 facet packs.db 插行 runner-serving（100.64.0.8、8791/32）；API 回读四行
- [x] 3.2 `docker stop agent-runner-dsh`
- [x] 3.3 facet `[fleet]`：**101s 判 stale → 8 条目一次改点 runner-serving**（6 pack 代理 + /chatlaw、/fingpt 两条 legacy 无 packId 条目——后者本就无 runner 托管，改点无害）；撞口环探真触发（doc-report-writer override 8807）；registry nginx 上游块已生成 100.64.0.8
- [x] 3.4 新 runner poll 6 served；rsync 的 home 使 spider-heal 直接 warm；旧容器零流量

## 4. 生产验证

- [x] 4.1 真回合链路：facade→registry→新 runner→child 冷启动（dsh-profile 脚手架+计费键 ref pk_87d4… 解析+审计行）→LLM 跳全部打通；**内容成功回执挂外部**——切换日 openrouter 上游大面故障（deepseek 502/gemma 限流/cohere 不可用，多键直连 curl 复现，与迁移无关），由计费结算行+错回合 waived 管道代证；上游恢复后以自然流量补
- [x] 4.2 计费闭环：两次 split-verify 回合 usage `settled`（minutes 1×$0.10）+ 部署者分成行 `$0.07/回合、commission 0.3、settled` 双双落账——**结算/分成链经新 runner 全通**。⚠ 两次失败回合误计 outcome:ok = F3.3 挂账缺陷②活体再现（已退演练号 $0.20，挂账清单加码）
- [x] 4.3 双宿主零浪费：切换窗口面板 runner-serving children=0/budget=0（kill 前多轮 poll 0 child）；child 仅在改点波后生长
- [x] 4.4 内存实证：pod 基座 42Mi（idle）、budget 0/3328 全额让 child；节点 cheap-4 2600Mi/33%（+4Gi Guaranteed 后仍最闲）

## 5. 卫生步

- [x] 5.1 fleet 表删 cheap-1 行；runner-serving 行 created_at 回填 1791733282363 成默认行 rows[0]（行龄同越孤儿宽限）
- [x] 5.2 Deployment 去 DEFAULT_ID（默认=自身收未打标）滚一次；poll 6 不变
- [x] 5.3 platform-config 种子 → http://100.64.0.8；ConfigMap 不动 pod template → facet/platform 手动 rollout restart，两侧 env 回读新值；facet 调度器重武装
- [x] 5.4 部署面选址：wave 已实打 putAgent→runner-serving 全语义；fleet>1+scheduler 自动选址代码路径 + rows[0]=runner-serving + 种子 env 三线一致（不再单独发测试部署，F3.3 已覆盖同代码路径）

## 6. 收尾

- [x] 6.1 DEPLOY.md 补「serving runner 独立 deployment」节（形态+切换配方+回滚+实录）
- [ ] 6.2 稳定观察（当日晚些）：面板/registry 10 条目健康、无回搬（滞回语义）、cheap-1 掉板 pruned
- [x] 6.3 cheap-1 容器退役更名 `agent-runner-dsh-retired-20261013`（stopped 留回滚位与 env 配方，卷保留；次日清）；openspec 归档 + 路线图 M4⑤ 勾注 + 记忆
