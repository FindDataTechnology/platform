# 生产 runner 随平台镜像发布，代码只经镜像通道落地

2026-10-06，fix-agent-data-workspace-writes 的窗口收口暴露出三件互相咬合的事实。其一：`agent-runner/docker-compose.yml` 自 ADR-0004 起就声明「同镜像第三角色」，但主 Dockerfile 的 runtime 阶段从未 COPY `agent-runner/`——镜像构建、冒烟全绿，只是 runner 角色起不来；于是 cheap-1 的生产 runner 一年里长成了 node:22-slim + 挂载代码的形态，最新功能靠 SFTP 原子换入（4 文件 + `.bak-<日期>` 约定）。其二：这个挂载代码同时持久着**运行时状态**（`llm-providers.json` 用户路由真件），换镜像时状态无声丢失，child 初始化即 `no adapter registered for provider`。其三：SFTP 通道下「仓库代码 ≠ 线上代码」的幽灵漂移不可审计——`agent-runner/docker-compose.yml` 描述的生产形态与实况不符，直到本次重锚才对齐。**决定：runner 恢复为平台镜像的第三角色（与 facet 同构），代码只经 GHA→hkccr→tcr-relay→ccr 的镜像通道落地；换版语义 = 换镜像 sha + 同卷重建容器；SFTP 热修自此除名，运行时状态一律落持久卷（`LLM_PROVIDERS_STORE` 等显式外置），不随代码载体漂移。**

## Considered Options

- **维持挂载代码 + SFTP 热修**：热修敏捷（不待 CI），但幽灵漂移不可审计、状态与代码混居、每次换版都要人工考据；且镜像缺口仍在——弃（本次重锚的动因即此）。
- **挂载源改 git checkout + pull 脚本**（轻量版）：比 SFTP 可审计，但延续「runner 不经镜像」的偏离，镜像缺口与状态混居两个根因都不动——弃。
- **节点本地构建 runner 镜像**：曾以 torch 层撞满 cheap-1 盘面（2026-10-05 实录）——弃。
- **runner 随平台镜像发布**（本决策）：镜像内容缺口一次补齐（主 Dockerfile + 开源快照 Dockerfile 双处 COPY），dsh 树与冻结 matrix 由构建期保证一致（cheap-1 的 `DSH_MATRIX_OVERRIDE=1` 遗留豁免随之关断，实测启动门 pass）；facet 同镜像第二角色先例在前。

## Consequences

- **换版 = 一次容器重建**：`agent-runner-data` 卷原地续用（homes/meter/fleet spool/LLM 路由真件），旧容器停掉改名保留作回滚位，重启语义 = 全部 child 重启（2026-10-06 实测可恢复；温区 agents 首触冷启）。
- **状态显式外置**：凡 runner 运行时写的状态一律经 env 指认到卷（本决策落地 `LLM_PROVIDERS_STORE=/data/llm-providers.json`；`PLATFORM_DATA_DIR=/app` 的旧习保留但在新形态下不再承载状态）。
- **bind 挂载目录退役**：`/opt/agent-runner-stage` 整体退役（代码、dsh、env、token 文件的角色各自迁移：代码入镜像、dsh 入镜像冻结树、env 迁 `agent-runner.prod.env`、token 迁容器 env）；验收后清理，.bak 系列再留一个周期。
- **镜像内容缺口是一类缺陷**：Dockerfile 的「兄弟角色 COPY」应有自检查（本次两处缺口——agent-runner 与 2026-09-28 的 chart-replay-allowlist.json——同族）。遵守协议：新增同镜像角色/运行时读取的静态资源时，同步补 COPY 并以一次性容器实测入口文件在位。
- **拆分部署清单三件套同滚**：platform / platform-demo / facet 清单的 sha 应同步推进；facet-proxy 模式下 `/api/packs`（含部署路由）在 facet 进程侧执行——只滚 platform 会得到「平台已新、部署路径仍旧」的假象（本次验收实录）。
- **supersede**：取代 ADR-0004 落地形态里的 bind 挂载变体（多租户 runner 归屋结论不变）；`agent-runner/docker-compose.yml` 从「Harbor 占位模板」升格为生产形态的真文件。