# dsh 是不可影响的上游：跟随者策略——矩阵锁死、合同套件作升级闸门、适配层收敛

平台对 @deepseek-ai/dsh 家族没有任何上游影响力，且该家族以约每日一个 lockstep rc 版本的速度移动（无 stable；dsh-base/dsh-sdk-protocol 的 latest dist-tag 停在首版从未更新，被动跟随 dist-tag 不可行），因此采用跟随者策略：一次锁死整个矩阵，让每次跟随成为受控小事件。四件事：①安装树由一份 dsh-matrix manifest 声明——只手写"意图级"条目（dsh、dsh-base、sdk 两个包；cordis-plugin-hmr 以 npm overrides 钉 1.0.16，1.0.17+ 删除 registerConfig 会开机崩环），peer 闭包由 npm 一次解析后冻结进 package-lock.json——历史手写的 18 行插件钉版是 legacy-peer-deps 关掉传递 peer 自动安装后的被迫承重结构（18/18 仅 peer 可达），其防漏职能由 lock 全面接管；②paas 与 agent-runner 启动时对比实际安装树与 lock，不一致拒绝启动（DSH_MATRIX_OVERRIDE=1 逃生口），把"重建装出错树"从运行时诡异故障提前为启动期明确报错；③dsh-contracts 合同套件（独立 runner，可对任意候选 dsh 安装试跑）钉住平台依赖的上游行为——boot/initialize 握手、闭包全量可解析、hmr 合同、settings/credentials 热重载、cordis patch disable+insert 语义与 profile scaffold、platform-sdk-server RPC 面（含唯一在用的内部 API PermissionPresetService.set）——接进镜像冒烟与矩阵变更 PR；④节奏：套件落地前钉死不动，落地后每 3-4 周跳到当时最新的"绿 rc"，中间版本直接跳过。两条长期规则同时生效：bridge 子类链冻结——唯一子类 platform-sdk-server 持 initialize/createSession override，今后新 RPC 一律走声明式方法表，不再叠加子类文件与 overlay；适配层边界为北极星——dsh-* 只许出现在适配层文件清单内（存量暂不强制清理）。11 个"改配置+重启子进程"调用点（模型/思考档/预设/工作区切换、pack 装卸、overlay 应用等；根因是这些参数烧死在 initialize 握手且 dsh 无对应 RPC）本轮全部接受现状，不自研新的内部 API 型实时 RPC——落后 19 版时是加深内部耦合的最坏时机；方法表服务器是未来痛点真实时加这类 RPC 的插槽。

## Considered Options

- 上推上游（要求 meta-bundle 聚合包 / setModel 等生命周期 RPC）：对 dsh 无影响力，不可行。
- fork dsh 自控版本：rc 每日 lockstep 移动，fork 的维护成本随每次上游发版复利，不可承受。
- 钉死永不升级：家族全部是 rc 无 stable，迟早被安全或功能逼跳；且 latest dist-tag 陷阱使被动跟随也不可行。
- 囤着等被迫时大跳：漂移每天 1 版复利（决策时已落后 19 版），跳跃距离只增不减，最终等价一次小迁移。
- 自研内部 API 实时 RPC 消灭重启：permissions/set 已证技术上可行，但每加一个内部耦合点就多一根每天可能断的线；留待跟上节奏且痛点仍在时经方法表服务器顺势加。
