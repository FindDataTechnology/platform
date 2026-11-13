## 1. fork 收敛到 1.32.0

- [x] 1.1 从 `1.32.0` tag 拉新鲜支线 `fd-1.0.0`，**按时间序** cherry-pick 重放集 14 提交（Logto 线 + wire 双 patch；剔除 `8ad0239f`/`2b36f87c`）；验收 = `git log` 谱系完整、除 `ef16fbeb` 两处单 hunk 并集外全部干净落位（spike 已实测）
- [x] 1.2 重缝 `auth_server/server.py` + `registry/main.py`：spike 实测仅两处单 hunk 并集（server.py import 取上游超集；main.py 上游 proxied_entities 块与我方 patch_key_router 块并排保留）；验收 = 两不变量各有单测锚定 + 语义位置复核（wgk 分支先于 provider 探测、preflight 在授权后 egress 前）
- [x] 1.3 复核 `f1d8caf0` 落位的测试于完整树运行（spike 显示落位干净，不需预先重整——只需跑通）；验收 = 全量 pytest 全绿（2026-10-05 本地 8764 passed/34 skipped/0 failed；此后常态门槛为 CI，见 1.6）
- [x] 1.4 控制台横幅版本串打 `fd-1.0.0` 标（BUILD_VERSION 烘焙，浏览器实证页脚 fd-1.0.0）；验收 = 控制台页脚/横幅显示 fd 版本
- [x] 1.5 删除 `logto-support` 分支（本地已删 2026-10-05；gitee 远端删除随首次 gitee push 一并做）；upstream remote 降级只读（保留 fetch tag 能力）；验收 = `git branch`/`git remote -v` 清爽
- [x] 1.6 GitHub 仓归位 + CI 门槛（2026-10-05 用户指示）：law-ai-official → **FindDataTechnology/mcp-gateway-registry** 转移完成、默认分支 fd-1.0.0、origin 重指、保留两测试套并加 `fd-*` 触发；验收 = push fd-1.0.0 后两套 CI 自动触发

## 2. 保守瘦身首迭代

- [x] 2.1 删 6 个未用 IdP provider + cognito_utils + factory 收口（508→77 行）+ `oauth2_providers.yml` 仅留 logto；id_token 测试由 Keycloak 夹具重指 Logto（17/17 绿）；验收 = 2026-10-05 完成（-9933/+41 行）
- [x] 2.2 面瘦身完成（2026-10-05，commit 778d9591）：删 charts/、terraform/、**infra/（CDK ECS 面）**、metrics-service/、docker/keycloak/、keycloak/、pingfederate/、docs（留 release-notes）——539 文件 -150232 行；6 个主体消失的测试删除、2 个引用测试适配；.github 部分已于 CI 建立时完成（commit 1e5308c9）；验收 = 本地 tests/security+observability 子集 259 passed
- [x] 2.3 CI 两套全绿（2026-10-05）：Auth 套 success（c60a80d2，3m11s）+ Registry 套 success（bf6af831，9m34s，含 telemetry 测试清理）；期间 CI 抓出并修复真缺陷——entra 回调分支死 import 破坏 fail-closed（已删分支）、回调测试重指 logto、10 个主体消失测试退役、1 个 secrets 竞态 flake 复跑通过

## 3. 镜像发布（标准 TCR 线；2026-10-05 按用户规范重规划）

原「cheap-1 本地构建」路线废弃——torch 镜像 ~3-4GB，cheap-1 在 export 层撞盘失败（复证本地构建不可行）。改为标准通道（openspec `tcr-image-pipeline` / `docs/IMAGE-RELEASE.md`）：`push github main → GHA 构建 → hkccr → cheap-3 tcr-relay 每 5 分钟回灌 ccr（广州）→ 节点拉取`。

- [x] 3.1 接入六步完成（2026-10-05）：`image.yml` 落仓（matrix `mcp-registry`+`mcp-auth-server`，hkccr/`yizuo`，provenance:false，BUILD_VERSION=fd-1.0.0）；TCR_USERNAME/PASSWORD 自 cheap-1 提取设为 repo secrets；cheap-3 `/etc/tcr-relay/repos.conf` 追加两仓（备份在案）；GitHub main 对齐 fd 线（旧 main `b3de738a` 备份）+ tag `fd-1.0.0`
- [x] 3.2 GHA image workflow 双镜像构建并推 hkccr 绿（2026-10-05，`sha-7fbc2d6`，~10 分钟）
- [x] 3.3 relay 回灌核验：ccr 双镜像到位、digest 与 hk 逐字节一致（手动触发一次 relay 提速）
- [x] 3.4 cheap-1 盘面准备 + ccr 拉取成功（含两次 containerd 内容仓故障外科处理：重启 containerd 零中断 + 重试）
- [x] 3.5 mcpgw 拉取并钉 `1.32.0`（compose 默认值同步改；容器已切，mcp-proxy 探针 200）

## 4. 生产部署（cheap-1 compose pin 更新 + 换版；2026-10-05 按规范重规划）

部署载体说明：注册处是 cheap-1 上的 compose 栈（不在 `fd-infra-deploy` 的 ArgoCD 应用清单内），因此最后一步 = **更新 compose 镜像 pin（随 gitee fork 仓提交）→ cheap-1 拉 ccr 镜像 → `up -d --no-deps`**；ArgoCD 同步不适用于本组件（若日后迁 k8s 属独立迁移）。

- [x] 4.1 compose pin 更新完成（cheap-1 备份在案；同改动提交 gitee fork 仓 `27342dea` 并推 fd-1.0.0+main）
- [x] 4.2 auth-server 换版：healthy；探针=合法 token 200(servers=7)/非法 401/伪造 wgk- 401 全过
- [x] 4.3 registry-1 换版：healthy、`/api/version=fd-1.0.0`、快照 diff 零丢失（7/152/5）、控制台 200；日志 2 行 error 为既有上游健康轮询失败（非本变更）
- [x] 4.4 回滚段已成文（维护文档 §6：备份双份在案 + 单服务回退目标 + 不可变 sha 保证）

## 5. 开面与灰度

- [x] 5.1 铸造面 e2e 完成（2026-10-05，ego-browser 登录 aloadtree 会话实测）：铸 201（`wgk-` 47 字符、明文仅响应一次）→ 无 cookie Bearer 实测 **200 + 7 servers**（真实鉴权链）→ 列表无明文字段（key_id/prefix/…）→ 吊销 200 → **吊销后立即 401**；惰性回归=JWT/快照行为不变（4.2/4.3 探针同证）。注：浏览器内「吊销后 200」为同页有效会话 cookie 的独立凭证，非绕过（无 cookie curl 已二分排除）；测试 key 三把全部吊销，终态 active=0
- [x] 5.2 预检灰度开启（2026-10-05）：`PREFLIGHT_ENABLED=true` + `SUB2API_BASE=http://103.236.89.212:32080`（宿主 NodePort，容器内实证可达）+ admin key（wanxing-fleet secret）+ `SUB2API_CALLER_MAP`；postpaid 观察窗先行使毕
- [x] 5.3 切 `PREFLIGHT_MODE=strict` + 空表终态；活链三态实测：充足（user:50）静默放行→直通上游｜不足（user:44）**402 INSUFFICIENT_BALANCE + 上游零触达 + 审计**｜计费面断连 **503 BILLING_UNAVAILABLE（strict fail-closed）+ postpaid 降级放行**；审计落 `/tmp/preflight_quota.jsonl`（STDOUT 镜像亦在）。坑在册：MAP 键=控制台登录名（/validate `x-user`），非 Logto sub；重启后首打可能 401（复打即愈）
- [x] 5.4 客户侧真回合完成（2026-10-05，演示口径）：客户身份（lawbenchtestadmin + Logto 角色 wire-customers + 最小 scope `mcp-business-wire-execute`）持 `wgk-` key 经 wire 门面全链通——initialize（finddata v4.0.10 握手）/tools/list/list_concepts（ETF 指标目录）/law_search（"数据安全法" 真结果 id=69671）/yearbook_search+read（2005 各地市单位GDP能耗真值）；**audit_events(gmc_server_access) 落行**（identity=patch-key/wire-customers/business-mcp only、canonical_id 齐、tool/session/request_id 齐）；`rows_returned` 戳在观察读取族实证（read→`_meta.rows_returned`，未采集占位不计语义正确）。注：sub2api 入账管道（ADR-0003 消费端）属 wire 线后续，数据源已就绪

## 6. 跨根收口与文书

- [x] 6.1 finddata 根收口（据实）：wire-platform-v1 **3.2 已勾选**（最小 scope 实证：外部身份列表恰 1 条、内部用户回归不变——口径为 Logto 角色而非 org，org 形态可平迁）；**4.4 留进展条目**（预检 402 半链已上线实证；账本硬停半链待 wire 线侧 sub2api 入账管道）——wire-platform-v1 因此**保持开放**，不强行归档；paas 侧跨根义务已履行
- [x] 6.2 ADR-0017 落盘（独立谱系，supersede ADR-0015 补丁模式条款）；验收 = `docs/adr/0017-*.md` 在仓
- [x] 6.3 改写 `docs/registry-maintenance.md`（谱系=fd 线、§5 债清偿、换版 recipe、安全单行道 ritual）；验收 = 文档与生产一致
- [x] 6.4 台账扩为谱系账本完成：历史补丁表（状态全更新）+ fd 发布记录 + SECURITY-LANE 登记簿（基线条目在册）+ 标准 TCR 线配方 / 本地构建废弃警示
- [x] 6.5 上游 PR 提交：**agentic-community#1847**（draft；分支 scs001:feat/patch-keys 基于 upstream/main 14f8589a，cherry-pick 80babe54+ef16fbeb 并剥离 preflight；patch-key 三件套 38 测试本地绿）
