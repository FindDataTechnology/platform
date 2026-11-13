# dsh 跟随进入统一代：一次跳 0.2.0-rc.2，锁冻加"允许缺席"剪枝名单，适配层边界升为 CI 强制

上游 0.2.0 起 dsh 家族以单一 lockstep 版本号发布且零 peerDependencies（全家族精确钉版硬依赖随本体走，hmr 家族化为 @deepseek-ai/dsh-hmr），壹座顺势把全部 dsh 依赖面（矩阵 lock、根 package.json、应用直接 import）统一到 0.2.0-rc.2 一个代，根安装与矩阵安装的 --legacy-peer-deps 全部摘除（单代干净解析已实证；历史上两代 peer 并存才是该旗的存在理由）。ADR-0007 的跟随者策略主体不变（矩阵锁死、合同闸门、3-4 周窗口跳最新绿 rc、bridge 子类链冻结、方法表服务器插槽），三处局部作废：cordis-plugin-hmr 1.0.16 钉版（包已消失）、overrides 双代抹平（单代无物可抹）、18 行仅 peer 可达插件的历史叙述（硬依赖化后类别消灭）。统一代的动机是多 harness：萬星定局为 agents 运行管理层（roadmap 2026-10-14），dsh 作为第一 harness 必须版本面干净才可替换——故新增第四件事：适配层文件名单入库并由 CI lint 强制（@deepseek-ai/* 直接 import 只许出现在名单内，名单与矩阵变更同评审轨迹），把"dsh 可替换"从口头纪律变成可验事实。统一代的代价是闭包变胖（283→516MB，主因 libreoffice-kit 平台二进制 159MB 与 dsh 自带 UI 部件 33MB），处置为镜像构建装后按入库评审的剪枝名单（dsh-matrix/prune.json）删除、boot 门对名单内缺席放行（日志标剪枝标记）名单外照旧拒启、合同②对名单内条目豁免解析断言——首刀两件均为"dsh-base 95 行插件表零引用"实证（壹座 office 走自有 python 层、永不渲染 dsh 自带 UI），pi-ai 链与 otel 经查为承重（dsh-profile.js:284 的 volces 线走 llm-pi-ai；session-telemetry-otel 插件行启用）不剪。跳代的门是九合同 candidate 试跑全绿（重点 ⑥ 内部 API、⑦⑧⑨ 昨日上产的活控制线协议）；⑥ fail 沿用既有归因流程（internal-API 标签 ≠ 自动不能跟）。桌面在统一后临时携带全家族闭包（~516MB），由后续 change single-source-desktop-runtime 收敛到剪后 ~324MB（predist 从矩阵单源安装、根 manifest 瘦身到 8 行直接 import 包），远期"首启下载运行时"另行 explore。锁手术与 npm overrides 占位被否决：lock 是机器产物不手编（README 纪律），overrides 换版本不删包；--omit=optional 被否决：会连真需要的平台二进制 optional 一起杀。

## Considered Options

- 朴素跳版不剪枝：镜像 +233MB，与压缩体积的初衷直接冲突，拒绝。
- lock 手术删行 / overrides 占位 stub：违 lock 机器产物纪律 / 引入新 fragility，拒绝。
- --omit=optional 全局开关：误杀平台匹配二进制等真需要的 optional，拒绝。
- 等 0.2.1-alpha 或下个 rc 再跳：囤版本只增跳跃距离（ADR-0007 原判），且多 agents 开工在即，拒绝。
- 把 dsh-api-session-controller（0.2.0 新 session 生命周期面，或可承接 11 个"改配置必重启"调用点）并入本轮：新功能面探索混入会拖长统一窗口、扩大爆炸半径，独立 explore，拒绝并入。
- 桌面本轮就做首启下载运行时：下载器/首启网络体验/版本校验是独立工程，不阻塞统一收益，另立 explore。
