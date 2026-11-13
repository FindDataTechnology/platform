# AGENTS.md — paas（壹座）工作区指令

> 本仓库的完整仓库导览见 `CLAUDE.md`（架构、命令、测试、部署细节都在那里）与 `CONTEXT.md`。
> 本文件只放**必须每次遵守、且容易被忽略**的少数硬规则。

## 出片与发布：先跑一条命令，不要人工调查

**任何**涉及镜像构建、出片、滚版、发布的任务，**第一步**是：

```bash
fd-build-channel            # 现在用哪条通道 + 各账号额度余额 + 成本陷阱（吃 24h 缓存，~2s）
fd-build-channel pick <项目> # 该项目走当前最佳通道的逐步命令
```

- 它是**唯一判路入口**；不要再靠读 `gh run view` 的注解试错。
- **私有仓 = 2000 分钟/月/账号**（GitHub Free，月初重置）；**公开仓标准 runner 免费无限**，
  且**不受同账号私有额度耗尽影响** → 能公开就优先公开。
- run 注解 `recent account payments have failed…` **不是欠费**，是**私有额度用尽**
  （实测 FDT = 2011/2000）；**私有 CI 全停、同账号公开仓照跑**。
- **macOS runner 计费 ×10**、Windows ×2。快照推全仓会误触 `app-e2e`/`win-install-smoke`，
  每次烧 80-170 分钟额度 → 推快照前**修剪到只剩 `image.yml`**，或直接用 `fd-build-snapshot`
  （它已排除 `/.github`）。

出片一条命令（私有源码走通用池）：

```bash
fd-build-snapshot <源码仓URL或本地路径> -R <org>/build-pool --namespace <TCR ns> --image <镜像名>
```

**纪律（用户 2026-10-11 明令）**：镜像**永远走 GitHub Actions 构建**，禁止在节点上本地
`docker build`；链路一律 `GHA → hkccr.ccs.tencentyun.com → cheap-3 tcr-relay → ccr`，**禁止 US runner 直推 ccr**。

- **非 web 端通道（2026-10-27 建制，revive-nonweb-ci）**：私仓只跑 ubuntu 经济门
  （web 六门 / app 三棒 / miniapp 三棒）；桌面 release 矩阵、win-smoke、APK/Maestro/iOS
  一切 mac/win/模拟器重腿一律走池侧分支通道或手动 dispatch，**不吃私仓分钟**。
  分工表+快照纪律+实测分钟见 `docs/registry-maintenance.md`「非 web 端通道」节。

## 判红两分法（额度 vs 真缺陷）

- run **5-10 秒即终、注解 payments failed** → 额度用尽：换有余额的池，或走公开仓线。
- run **跑了 ≥10 秒**在业务步红 → **真缺陷或 flaky，必须 `gh run view <id> --log-failed` 看错误文本**，
  **别默认 flaky、别当额度问题**。（已知 flaky 仅 dsh 合同 ⑨；2026-10-14 `896e142` 是**真回归**：
  `ctx.userQuestions.registerProvider is not a function` → `/api/ready` 超时。）

## 本仓工作方式

- **`.zcode/` 不入库**（`.gitignore:79`）：本地 skills / hooks / config 只在本机生效，不要提交。
- 出片/发布运行手册：`.zcode/skills/deploy-registry-image/SKILL.md`（registry 专项，含 relay、
  cheap-1 切换、验证证据链、回滚）；ppas 通用上线线再看全局 skill `paas-release` / `tcr-image-pipeline`。
- OpenSpec 流程：`openspec/changes/` 提案 → apply → archive（见本仓 `.zcode/skills/openspec-*`）。
- **并行会话常见**：提交只 `git add` 本变更文件，**勿 `-A`**（树上常有其他会话在途 change）。
- 台账：`docs/registry-maintenance.md`（§1 运行表 + §9 发布记录）；每次发布后更新。
