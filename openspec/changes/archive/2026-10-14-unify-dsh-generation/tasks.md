# unify-dsh-generation — Tasks

## 1. 矩阵清单统一（dsh-matrix/）

- [x] 1.1 dsh-matrix/package.json 意图条目收敛为统一代（dsh + dsh-base + sdk-jsonrpc-server 三行组合事实，全部 0.2.0-rc.2），删除全部 overrides（hmr 钉版随 cordis-plugin-hmr 消失退役）
- [x] 1.2 在 dsh-matrix/ 重新生成 lock；核对 278 个 dsh 族行全部 0.2.0-rc.2（统一代唯一）
- [x] 1.3 对 scratch 树跑九合同 candidate 模式，重点核 ⑥⑦⑧⑨；subagent 族行为记录为观察项
- [x] 1.4 合同 fail 归因：④⑦=settings 模型重设计、⑥=preset 系统重设计 → D7 适配切片（用户已接受扩范围）；九合同全绿（未剪树 + 剪后树各一轮）

## 2. 剪枝机制（prune + boot 门）

- [x] 2.1 建立 `dsh-matrix/prune.json`：首刀名单 libreoffice-kit 家族 + dsh-web-app/client-ui-*/web-frontend，每条附理由与"dsh-base 插件表零引用"证据
- [x] 2.2 `lib/dsh-matrix-verify.js` boot 门读 prune 名单：名单内缺席放行并日志标注 pruned，名单外照旧拒启；sanity 实测 ok/pruned:57/missing:0
- [x] 2.3 Dockerfile dsh 安装层加装后剪枝（npm ci → node dsh-matrix/prune.mjs --tree /opt/dsh）；prune 两文件随早期 COPY 入层
- [x] 2.4 合同②解析断言豁免（名字匹配 + 锚感知：被剪包路径下嵌套行一并豁免）；scratch 树装后/缓存命中路径均剪枝到出货形状；剪后树九合同全绿
- [x] 2.5 镜像体积落账 1.49GB（sha-f7d7c39，workflow summary 在案；dsh 载荷=剪后矩阵 320MB+根树 8 行）

## 3. 根 manifest 统一（package.json）

- [x] 3.1 根 40 行逐行核对：cordis-plugin-hmr 行与 overrides 删除（包消失）；dsh-code-runtime 行删除（无代码引用且无统一代版本）；其余 36 行全部 bump 0.2.0-rc.2
- [x] 3.2 根 lock 重生成；本地 `npm install`（无 --legacy-peer-deps）成功即回归探针（exit 0，root dsh@0.2.0-rc.2）
- [x] 3.3 摘 --legacy-peer-deps：Dockerfile、ci.yml(3)、app-build.yml、release.yml、app-e2e.yml(3) 全站点；grep 复核无残留
- [x] 3.4 以镜像仓 image-build-check/CI 免费车道复核替代（单测 1201/1201 全绿含 spawn 链）；e2e 车道随下次私有额度恢复回归

## 4. 合同③改写（dsh-contracts）

- [x] 4.1 contractHmrRegisterConfig 重写：断言 `@deepseek-ai/dsh-hmr` = 意图钉版代 + boot 稳定（cmpVersion 及版本界断言退役）
- [x] 4.2 候选模式 runner 的破坏示例场景去 hmr 化（"任一合同破坏的候选安装"）
- [x] 4.3 全套件对 0.2.0 scratch 树（含剪枝态）重跑全绿 ×2 轮

## 5. 适配层 lint（dsh-adapter-boundary）

- [x] 5.1 适配层名单入库 `scripts/dsh-adapter-files.json`（14 文件：实测 lint 校准——初版名单漏 tool-search-bridge、多列 tool-scope，被 lint 自己抓出修正）
- [x] 5.2 grep 级 lint 脚本（ESM from + CJS require 双模式）+ 名单外引用 CI 失败；接进 ci.yml lint job
- [x] 5.3 名单与实际引用集合一致性校验（stale/missing 双向断言，防名单腐烂）

## 6. 决策落盘

- [x] 6.1 新 ADR-0023（统一代跳跃 + 允许缺席剪枝政策）；ADR-0007 头部 superseded 注记
- [x] 6.2 dsh-matrix/README.md 升级步骤改写：单行意图条目、剪枝名单复核步骤、overrides/18 行 peer 历史段落化、0.2.0 host 面收编备忘

## 7. 出片与上产（paas-release 标准流程）

- [x] 7.1 出片 sha-f7d7c39（scs001 公开免费线）：四门全绿——/api/config 5s、/api/ready {ready:true}、九合同 9/9 on /opt/dsh、模块同一性 ✓；relay ccr 硬门 skopeo 实证
- [x] 7.2 生产滚动完成：六清单（platform/platform-demo/facet/agent-runner-serving/-b/-c）→ sha-f7d7c39，ArgoCD 自同步 84350ac，rollout 6/6 成功；生产实证=boot 门直跑 gate:pass/pruned:57/missing:0 + gateway 服务 + cell 树健康（⑧⑨ 生产行为由容器内合同 9/9 覆盖）
- [x] 7.3 交互回归收口：⑧ session/cancel、⑨ 多会话并发在本镜像容器内对 /opt/dsh 实测 PASS（live-control 线协议 0.2.0 存活的直接证据）；后续自然流量观察随日常

## 8. 0.2.0 适配切片（D7——合同门归因后扩入，用户 2026-10-14 接受）

- [x] 8.1 settings→profile patch 行迁移（D7.1）：targetPaths().settings 指向 profiles/<name>/cordis.patch.yml；writeLlmProfile 改 llm-pi-ai 行 upsert（dsh-hmr watch 热应用）；credentials 零迁移实证
- [x] 8.2 preset→声明式行迁移（D7.2）：writePresetsPatch 重写为 registry 行 + standard 行 + N persona 行 + 桥行；resolveShippedPresetRoot/composeAgentPreset/目录组合退役；catalog/custom 预设 defs 化（.agent-presets.defs.json 持久化，knownPresetIds/hasCatalogAgentPreset 改读 defs）；compose.js runner 侧改传 extraPresets
- [x] 8.3 standard 组合翻译（0.2.0 host 面收编对账）：dsh-profile-template/standard.agent.cordis.yml 重写为部署自有残余（persona prefix 行 + tool-ask-user 行）；persona schema text→prefix；workflow-worker-thread 行随包消失删除
- [x] 8.4 合同④⑦改写（D7.3）：热重载断言改 patch 行编辑（upsertHotRouteProvider）；runner settingsPath 指向 profile patch
- [x] 8.5 桥接面：platform-preset-bridge trust 字段默认 system（声明式注册表无 trust 维度）；agentPresets 服务名/list()/mount() 实证存活零改动
- [x] 8.6 自检与测试更新：test-catalog-agent-presets.mjs 重写为 defs 模型断言（全绿）；dsh-profile.js 自检块同步（presets overlay/组合自检/deriveScope 种子改 defs）
- [x] 8.8 user-questions 桥 0.2.0 waterfall 接缝（D7.5，容器 /api/ready 门拦截后修）：registerProvider→ctx.on("user-questions/request") 应答者；answer/abort 双向解绑；问询双线协议形状不变；本地六层 overlay CELL BOOT 1.3s 实证（commit 28d7778）
- [x] 8.9 全仓 lint 债清零（私有池瘫 CI 期间累积 18+ 错误；公开免费 CI 暴露）+ packs.js 列表序全决定性（published_at DESC, rowid DESC）+ 测试期望序修正；单测 1201/1201（commit 28d7778）
- [x] 8.7 SDK client spawn API 迁移（D7 补录）：0.2.0 的 HarnessClient 丢弃 command/args 选项（改 resolveDshLaunch 的 dshBin/profile/patches，平台无法经由它表达自组合 argv）——六个 spawn 点（dsh-bridge/agent-runner/合同 runner/两探针/session-resume）迁移到构造器第二参数 runtime 直通车（lib/dsh-client-launch.js 共享工厂，语义与 0.0.1 的 command/args 零漂移）；暴露根因=npm install 残留旧嵌套 client 掩盖断裂、npm ci 清扫后显形
