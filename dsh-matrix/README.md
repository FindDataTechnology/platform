# dsh-matrix — dsh 运行时安装矩阵

镜像内 dsh 运行时的**唯一版本真相**（ADR-0007 跟随者策略；0.2.0 统一代起另见
ADR-0023）。Dockerfile 的 dsh 安装层从这里的 `package.json`（意图级钉版）+
`package-lock.json`（全闭包冻结）做 `npm ci`，再按 `prune.json`/`prune.mjs`
做装后剪枝。

## 规则

- `package.json` 只手写**意图级**条目：dsh 本体、dsh-base、sdk-jsonrpc-server
  ——即平台 profile 直接组合的三件事（bundle、insert 行）。0.2.0 起全家族以
  精确钉版硬依赖随本体发布、零 peerDependencies，**overrides 已退役**（历史
  上它抹平 rc.2/rc.5 双代并钉 cordis-plugin-hmr 1.0.16；该包已家族化为
  `@deepseek-ai/dsh-hmr`）。
- **lock 是生成物，不手编辑**。升级 dsh 版本 = 改 package.json 意图条目 → 在
  本目录重新生成 lock → 跑合同套件 → 复核 prune 名单。
- **剪枝（ADR-0023 D2）**：`npm ci` 后运行 `node prune.mjs --tree <安装根>`
  删除平台 profile 证实不加载的包（准入证据 = dsh-base 插件表零引用）。boot
  门（lib/dsh-matrix-verify.js）读同一 prune.json：名单内缺席放行（日志标
  pruned），名单外缺席照旧拒启。名单变更与 manifest 变更同评审。禁止以 lock
  手术实现剪枝。
- `.npmrc` 刻意**不含** `legacy-peer-deps`（历史 Dockerfile 用它关掉了传递
  peer 自动安装，才被迫手钉 18 个插件包——该类别随 0.2.0 硬依赖化消灭）。

## 桌面同源（single-source-desktop-runtime）

桌面安装包与服务器镜像**共用这一个源头**，不再有第二条路径：

- 镜像：Dockerfile 的 dsh 安装层 `npm ci` 到 `/opt/dsh` → `prune.mjs --tree /opt/dsh`
  （同一 RUN 里 `--tree /app` 剪应用树）。
- 桌面：`predist` 的 `scripts/install-dsh-matrix.mjs` —— staging `npm ci`（同
  manifest+lock+.npmrc）→ `prune.mjs` staging → 平铺并入 app `node_modules`
  （不覆盖 npm 已解析的包）→ **再 `prune.mjs --tree <app 根>`**。
- 合同 scratch 树：`ensureScratchTree` 同样 `npm ci` + 剪枝（出货形状）。

为什么 app 树也要剪：根 `package.json` 保留的 `dsh-sdk-client` 在 `dependencies`
里硬写 `@deepseek-ai/dsh`（其 `lib/` 实际零处 import 裸 dsh，是发布方的元数据
冗余），dsh 又硬依赖全家族——所以根树**永远**传递携带整个闭包，与根清单列几行
无关（2026-10-14 干净安装实测：290 个 `@deepseek-ai` 包 / 219MB）。剪枝是各树
达到同一出货形状的唯一手段：剪后 233 包 / 33MB（-186MB = libreoffice-kit
148MB + dsh 自家 UI 38MB）。

## 上游陷阱备忘

- `dsh-base` / `dsh-sdk-protocol` 的 `latest` dist-tag 停在首版从未更新——
  任何"装 latest"都会拿到最老的包。跟随上游必须显式读版本清单。
- 上游 lockstep rc 版本（monorepo 统一发版）。节奏政策见 ADR-0007：每 3-4
  周跳最新绿 rc，中间版本直接跳过。
- 0.2.0 的 dsh-base 把整个 agent host 面收编进 bundle（工具/技能/plan/压实/
  subagent/workflow 全在内）——部署组合只剩 persona 与部署自有行，见
  `dsh-profile-template/standard.agent.cordis.yml` 的翻译注。

## 升级步骤（每 3-4 周窗口，ADR-0007/0023）

1. 改 `package.json` 意图条目到目标 rc（单行版本号，无 overrides 可同步）。
2. 重新生成 lock：在本目录 `npm install --package-lock-only`。lock 是机器
   产物，PR 的评审对象是 `package.json`，lock Diff 只作旁证。
3. 跑合同套件：仓库根 `npm run dsh:contracts`（scratch 树自动 npm ci +
   剪枝到出货形状后九合同全跑；`--fresh` 强制重建）。
4. **九合同全绿 → 跟**：合并 PR 即完成升级。镜像冒烟与矩阵 PR CI 会各再跑
   一次同一套件兜底。
5. 有 fail → 看逐条归因再决定：
   - 公开面合同 fail（①②③④⑤⑦）= 不能跟，先解决或等下一个 rc；适配工作
     落在 dsh-profile.js 适配层（0.2.0 跳版的 settings→profile-patch 行、
     preset→声明式行迁移即实例，见 change unify-dsh-generation design D7）；
   - 带 `internal-API` 标签的 fail（⑥）= 上游动了内部面
     （PermissionPresetService.set 一类），评估替代实现或继续锁旧版，不是
     自动的"不能跟"；
   - ② fail 且报告指剪枝名单内条目 = 检查 prune.json 是否漏了豁免接线。
6. 复核 `prune.json`：新增的"大件依赖若不被 profile 加载"候选进评审；上游
   若开始加载某已剪包（dsh-base 插件表新增行）→ 移出名单。

## 合同 ⑨b（收尾交错，advisory）

`⑨b close-under-concurrency` 是 **advisory** 行：照常打印 PASS/FAIL 与 detail，
但**不计入失败数、不影响 exit code**，摘要末尾单列。存在原因是它钉住的行为在
冻结矩阵上可能长期为红，而一个永远红的门禁不是门禁。

它问的是平台 `TURN_DISPATCH=concurrent` 策略所依赖的严格性质：两个会话**都**
有挂起请求时释放，双方能否都无 cancel 收尾到 idle。⑨（派发并发）只证明较弱的
一面——B 在 A 挂起时能派发；A 收尾时 B 早已结束，所以单边挂起会假绿
（实测 6/6 假绿后才改成双边挂起）。

**开启 `concurrent` 的条件**：候选矩阵 ⑨b PASS，**并且在慢速/多 chunk 的
dummy 上重复足够多轮**（上游记录称该缺陷非确定）。满足后由一次 dsh 升级 change
同时做三件事：矩阵升级、`TURN_DISPATCH` 默认翻 `concurrent`、⑨b 升格为门禁
（同时设 `DSH_MATRIX_CLOSE_INTERLEAVE=1`，代码在 `server/turn-dispatch.js`
`resolvePolicy`）。

**2026-10-19 实测（冻结矩阵 0.2.0-rc.2）**：双边挂起、`heldCount()>=2` 前置断言，
5/5 PASS。**未采信**：与 ⑨ 的内联记录（"rc.2 收尾不交错、非确定卡死"）矛盾，
5 轮不足以反证非确定性，且 dummy 单 chunk 远快于真实 provider。默认策略仍为
`queue`。完整记录见 `openspec/changes/concurrent-chat-sessions/notes/dsh-contract-9b-measurement.md`。

### 2026-10-20 勘误与新事实（⑨b 证据重估）

**勘误：2026-10-19 的「⑨b 5/5 PASS」是空转绿，证据力为零。** 当晚 dummy 的 `[HOLD]`
匹配的是**最终消息**；而每个新会话的首回合会先发一个**标题生成 side call**（system=
"Create a concise title…"，最终消息=用户原文）——park 住的是 titler，真正的会话请求
（最终消息是 dsh 注入的 skills system-reminder，不含 marker）**从未被 park**，回合即时
完成。所谓「双方挂起后释放、双双无 cancel 收尾」问的问题从未被问过。

**更深的协议事实**：rc.2 的每个回合还会发一个 "Current runtime context. This snapshot
supersedes…" 的上下文维护 LLM 调用（trace 实证：⑧ 的 prompt 只产生了 context 调用 +
titler，会话请求在部分状态下根本不发出）。一次 marker 实验里三种请求（会话/上下文维护/
标题）先后被 park 过，各自制造不同的假形状。**结论：不建模这套请求协议，dummy 侧做不出
诚实的 ⑨b**；重建 harness（识别三类请求、marker 只作用于会话请求、慢流多轮）是 ⑨b 升
门禁的前置工作，未完成前 ⑨b 保持 advisory 且其 PASS 不作为任何决策依据。

**0.2.1-rc.2 全量合同实测（2026-10-20，--tree 干净安装）**：8/17——④ 凭据热重载真回归
（轮换后的凭据不再逐请求生效，Authorization 迟迟不出现）、级联 ⑦⑧⑨⑩⑯（此后 prompt
到不了 adapter）、⑫ `ctx.subagents.start is not a function`（内部 API 变面）、⑮ delta
lane 死。按本 README 升级纪律：公开面合同红 = **不能跟**，等下一个 rc 或上游澄清。
（③ 的红是 manifest 未随动的预期产物，不计。）

**concurrent 的证据路线改判**：在 harness 重建完成前，`concurrent` 的开启证据改为
**真实 cell 实验**（临时 cell、TURN_DISPATCH=concurrent、真实 provider、多轮双会话并发
prompt、断言双 agent_start 重叠 + 双 done + 无 error + 无楔死）——记录见
`openspec/changes/<policy-flip-change>/notes/`。
