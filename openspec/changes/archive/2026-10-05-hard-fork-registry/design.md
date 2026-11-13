# design：hard-fork-registry

## Context

生产注册处是三条漂移线：registry-1=上游预构建 1.30.0（无我方代码）、auth-server-1=fork（1.29.0-79 基线+补丁，wire-20261005）、mcpgw=未钉 `latest`。fork main 为裁剪快照（secrets/ 删除、tests 仅 5 文件）。上游至 1.32.0 领先 238 提交；`validate_request`/`_authorize_forwarded_mcp_body`/`mcp_proxy` 三个锚点在 1.32.0 健在。

**重放已实测**（2026-10-05 干跑演习，一次性克隆）：按时间序依次 cherry-pick 14 提交——12 个干净落位提交，唯一冲突是 `ef16fbeb` 的两处 **hunk 级并集**（`server.py` 一行 import：上游为超集；`main.py`：上游 `proxied_entities` 块与我方 `patch_key_router` 块并排保留）；`f1d8caf0` 测试在完整树上亦干净落位。fd 候选树足迹 = 32 文件 +9181/-22，`py_compile` 绿。**教训：逐提交孤立干跑会因链式依赖（Logto 链改的是前序提交新增的文件）产生假冲突，重放必须按时间序；消解冲突禁用整文件 `checkout --ours`（会冲掉自动合并的 hunk）。**

## Goals / Non-Goals

**Goals:**
- 一次性收敛到 1.32.0 并建立 fd 版本线，双容器同窗换版，wgk 铸造面与预检灰度就位
- 换版全程可探针、可一步回滚

**Non-Goals:**
（设计层补充，非重复 proposal）不重建上游 CI；不改消费方契约与域名；不动 mongo/openbao 存储；不做激进瘦身。

## Decisions

### D1 收敛方式：从 1.32.0 拉新鲜支线 + cherry-pick，而非 merge 进裁剪 main
- 238 提交 merge 进删过文件的树 = 被裁路径全面冲突风暴；新鲜支线自动恢复完整测试套（8614+ 上游用例回归能力是本次收敛最大的免费红利），上游自带的 `registry/secrets/` 仅为 9 个模板文件，无需 re-scrub。
- 备选「rebase 到 1.30.0（生产 parity）」被弃：保不住 1.31 的读面过滤（wire 3.2 会从配置题退化为开发题）且带着已知安全缺口切独立。

### D2 重放集 = 16 剔 2
- **剔除 `8ad0239f`**（裁剪提交本身——落上去会把完整树又裁回去）与 `2b36f87c`（fork 内部 docs 标记，无工程意义）。
- `f1d8caf0`（为裁剪谱系适配的测试）在完整树上重整：自包含 inline fixture 可保留，与上游恢复的测试重复/冲突部分以上游为准。

### D3 server.py 钩子重缝的不变量
沿用 patch ①② 的两条排序不变量，缝进 1.32.0 的函数体：① wgk- 前缀分支在 `/validate` 凭证分派处先于一切 provider 探测（惰性——零 key 时与旧行为逐字节一致）；② preflight 钩子在 `_authorize_forwarded_mcp_body` **之后**、任何 egress/vend 之前（真正的 403 永不被计费判定掩盖）。1.32.0 新增的鉴权路径（backend identity、generic gateway）默认不吃 wgk——首版不扩展，验证矩阵显式覆盖「新路径持 wgk- 仍 401」防意外放行。

### D4 瘦身与收敛分离提交
收敛提交（纯 cherry-pick + 缝合）与瘦身提交（删 6 provider/factory 收口/oauth2_providers.yml 6 条、charts、terraform/ECS、metrics-service、docker/keycloak、docs 大部；**.github 保留两个测试套 workflow、删其余上游 CI 与 dependabot**，2026-10-05 修订）分开落，保持 bisect 可用；瘦身保持「上游安全修复高频路径（skills、ARD、federation、server 代码本体）不动」的边界。

### D5 版本机制
- 仓库与软件名不动；tag `fd-1.0.0`；镜像 `mcp-registry:fd-1.0.0`、`mcp-auth-server:fd-1.0.0`；mcpgw 钉上游 `1.32.0`（与收敛基线同版，转发 hop 无我方代码）。
- 控制台横幅版本字符串打 fd 标（一行改动，随收敛提交走）。
- upstream remote 保留为只读参照（fetch tag 供安全单行道摘取），`logto-support` 分支删除存档。

### D6 换版顺序与门槛（每步独立可回滚）
```
[0] 全量 pytest（含重放的 patch 用例 + 8614 上游用例）
[1] auth-server:fd-1.0.0   ← recipe 已验证（10-03/10-05 两轮）；门槛=10-03 鉴权矩阵探针全绿
[2] registry:fd-1.0.0      ← 首次 fork 构建该容器；门槛=市场快照 diff 探针（同一 bridge 凭据，
                              server/工具集无未解释缺失）+ 控制台冒烟
[3] 开 PATCH_KEY_AUTH_ENABLED（铸造面）；门槛=铸/列/吊销 e2e + 惰性回归（存量 JWT 行为不变）
[4] 配 SUB2API_CALLER_MAP → 开 PREFLIGHT_ENABLED 灰度；门槛=三态（放行/402/503）探针
```
- 回滚统一走既有 tag 互换 recipe（`--no-deps --no-build`），env 开关各步可单独关回。

### D7 安全单行道机制
台账（`docs/registry-fork-patches/`）从补丁账本扩为谱系账本：每条登记「来源提交 → 移植提交 → 测试凭证 → 发布 tag」。保留 fork 树内 `docs/release-notes/`（截至 1.32.0）作离线参照。

### D8 上游对冲
fd-1.0.0 切出后以独立分支向 upstream PR patch ①（per-user 长命 key，上游无对应物；PR #1791 继续养）。动机是缩小分歧面降低未来安全摘取成本，非回归上游怀抱。

### D9 CI 门槛 = GitHub Actions（2026-10-05 修订原「不建 CI」决定）
GitHub 仓归位 **FindDataTechnology/mcp-gateway-registry**（私有；自 law-ai-official org 转移；`origin` remote 已重指；默认分支 fd-1.0.0）。保留 auth-server-test + registry-test 两个 workflow 并加 `fd-*` 触发分支——测试从「本地手跑」改为「push 即 CI」，本地全量降为可选。理由：全量套件本地 14 分钟，等待成本高且占用开发机；GitHub 私有仓既有 Actions 配额足够（月度数轮）。

## Risks / Trade-offs

- [1.31 读面按调用者过滤改变市场快照] → 换版门槛 [2] 的 diff 探针；若缩水可由可见性策略解释，记录解释后放行。
- [server.py 缝合遗漏 1.32 新鉴权路径意外接受 wgk-] → D3 验证矩阵显式覆盖；惰性前缀门是结构性护栏。
- [registry 镜像首次 fork 构建：SPA 需 node builder 基镜像，cheap-1 拉取困难] → 沿用轩辕加速镜像预拉打标配方（auth-server 的 python 基镜像同法）。
- [上游 schema 演进（virtual servers/skills 等新集合）首启迁移] → 1.30.0→1.32.0 跨版首启在换版窗口内完成；回滚后新集合对旧版惰性无害（未知集合被忽略），已写入门槛 [2] 冒烟清单。
- [sub2api 预检 fail-closed 误伤生产] → 预检保持默认关 + 未映射跳过双护栏；灰度先 postpaid 模式观察审计流再切 strict。
- [wire 3.2 依赖 finddata 根的 Logto org 配置] → 跨根动作在 tasks 显式立项，收口不藏在 paas 侧。

## Migration Plan

见 D6 顺序；窗口内 [1][2] 同日完成（同一棵树、同一批镜像），[3][4] 按灰度节奏独立进行。全部落定后跨根勾 wire-platform-v1 3.2/4.4 并归档该 change。

## Open Questions

（无——原「mcpgw `latest` 实际指向」已于 2026-10-05 SSH 核实：现行镜像创建于 2026-08-24=1.30 时代，钉版上游 `mcpgw:1.32.0` 为前进对齐，无回退顾虑。）
