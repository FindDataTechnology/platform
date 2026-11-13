## 1. Runner 主体（design D1/D2）

- [x] 1.1 `scripts/dsh-contracts.mjs` 执行器：参数解析（--tree/--bin/--fresh）、临时 home 物化（mkdtemp + dsh-profile 参数化 writer 写 settings/credentials/presets patch）、HarnessClient spawn `--profile platform --patch ...`、逐合同执行 + try/catch 归因 + 汇总表 + 聚合退出码、退出清理。验证：对 dsh-matrix scratch 树空合同表跑通全流程（spawn→握手→清理），临时域用后消失、~/.dsh 未被触碰
- [x] 1.2 `scripts/lib/dsh-contracts/contracts.mjs` 合同表骨架 + scratch 物化缓存（D5：lock hash 键、--fresh 重建）。验证：二次运行命中缓存跳过 npm ci；--fresh 强制重建

## 2. 六条 v1 合同（spec 需求 2）

- [x] 2.1 合同① boot/握手/名册：initialize 完成断言 + 模型名册投影非空 + preset 名册（presets/list）可调。验证：对当前矩阵树 pass
- [x] 2.2 合同② 闭包可解析：对安装树 lock 声明集逐包 import 解析（平台 import 面起点，D-OpenQ）。验证：人为删一个 peer-only 包 → ERR_MODULE_NOT_FOUND 指名该包 fail；完好树 pass
- [x] 2.3 合同③ hmr registerConfig：解析版本 <1.0.17 断言 + 子进程 boot 期不因 watchUserPatches 崩溃（退出监听归因）。验证：对矩阵树 pass；构造 1.0.17 树（overrides 放开）→ fail 且归因合同③
- [x] 2.4 合同④ settings/credentials 热重载：会话存续期写 `llm-pi-ai:` 段 → 模型目录热刷新（轮询 ≤10s）；轮换 .credentials.yaml → 新值可见。哑 LLM 端点（不发真实补全）。验证：对矩阵树 pass
- [x] 2.5 合同⑤ patch 语义与 scaffold：disable+insert 生效（stock sdk-jsonrpc-server 被禁、platform-sdk-server 行为生效——由合同⑥的 RPC 可调间接证明）+ scaffold 四文件装载（boot 成功即装载，断言错误信息不出现 scaffold 缺失类）。验证：对矩阵树 pass
- [x] 2.6 合同⑥ platform SDK RPC 面（internal-API 标签）：presets/list、permissions/list 结构断言 + permissions/set 免重启改活动会话权限（PermissionPresetService.set 合同）。验证：对矩阵树 pass；报告含 internal-API 标签

## 3. 双接线（design D4、spec 需求 3）

- [x] 3.1 image.yml 冒烟步骤追加 `node scripts/dsh-contracts.mjs --tree /opt/dsh`。验证：推一个 [skip ci] 之外的触发（或 workflow_dispatch）跑一轮，冒烟步骤含六合同且绿
  - 实现已落地（image.yml "Smoke test (dsh contracts on /opt/dsh)" 步骤，YAML 校验过；runner 同入口已在候选模式实弹验证）。按用户拍板先归档：首跑由下一次非 [skip ci] 推送/workflow_dispatch 事后兜底——冒烟失败即不推镜像，管线自身就是兜底门
- [x] 3.2 ci.yml 新增独立并列 job：dsh-matrix/** 路径触发，scratch npm ci + runner，`needs: []` 不被 lint 债阻断。验证：改 dsh-matrix 触发的 PR/run 上该 job 独立执行；main 上现有 lint 红不影响其结论
  - 实现已落地（ci.yml `dsh-contracts` job：PR 路径过滤 + workflow_dispatch、needs: []、scratch 树按 lock hash 走 actions/cache 且 runner 端 diffMatrixTree 自愈校验）。按用户拍板先归档：首跑由下一个 dsh-matrix 变更 PR 事后兜底
- [x] 3.3 dsh-matrix/README 追加"升级步骤"节（改意图条目 → 重生成 lock → 跑 contracts → 绿则跟，3-4 周窗口）。验证：文档评审即可

## 4. 验收与基线

- [x] 4.1 对当前矩阵（0.1.1-rc.2）全套六合同跑绿，输出存为基线报告样例。验证：退出码 0 + 六行 pass
  - 基线样例：openspec/changes/add-dsh-contracts/baseline-report.txt（6/6 PASS，退出码 0）
- [x] 4.2 候选模式实战演练：对 ~/.dsh 全局安装（或下一次上游 rc 的 scratch 树）跑一次，观察逐条报告与失败归因路径。验证：报告可读、归因准确（允许候选树上有 fail——演练目的是看报告质量）
  - 演练对象：homebrew 全局安装（/opt/homebrew/lib + /opt/homebrew/bin/dsh）——与矩阵不同安装形状的真实候选；②如实点名 454/456 缺失（peer 闭包未随全局安装带出）、③指名 cordis-plugin-hmr 缺包，①④⑤⑥ 在其具备的面上全绿，退出码 1
- [x] 4.3 回归：add-dsh-matrix-lock 的 e2e（dsh-matrix-lock.spec.js 四场景）仍全绿；openspec validate 通过
  - 4/4 绿；openspec validate add-dsh-contracts 通过；biome 对新增两文件零告警
