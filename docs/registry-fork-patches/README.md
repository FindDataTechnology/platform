# Registry fork 谱系账本（cheap1 `/opt/mcp-gateway-registry`）

> 自 2026-10-05 起，registry 跑**独立谱系 fd-1.0.0**（ADR-0017）：上游收敛到 1.32.0 一次后切断，
> 功能永不再追；上游关系 = **安全单行道**（发版 notes 一周内评估、仅安全提交摘取）。
> 本文件 = ①历史补丁台账 ②fd 发布记录 ③安全单行道登记簿。
> 维护总览：`../registry-maintenance.md`。

## 一、历史补丁台账（均已随 fd-1.0.0 进入生产）

| Patch | 内容 | 状态 |
|---|---|---|
| `2026-10-03-logto-enriched-groups-scope-remap.patch` | auth-server `/validate`：DB 富化 groups 的 scope 重映射（上游 #1127 只修 PingFederate；我们泛化到 logto）。没有它，平台 `paas-agent-callers` 组拿不到 `invoke_agent` → A2A 403 | **LIVE**（fd-1.0.0 内，sha-7fbc2d6）；曾以 `mcp-auth-server:logto` 单独部署（回滚锚已随 fd 切换退役） |
| `2026-10-04-per-user-longlived-keys.patch` | patch ①：控制台自助铸/列/吊销不设过期的 `wgk-` key（SHA-256 入 `patch_keys`，明文仅铸时一次；scope 随用户组映射现算）。`PATCH_KEY_AUTH_ENABLED`（默认开）+ `PATCH_KEY_MAX_ACTIVE_PER_USER`（默认 20） | **LIVE + e2e 实测**（2026-10-05：铸 201/明文仅一次 → 无 cookie Bearer 200+7 servers → 列表无明文 → 吊销 → 立即 401；惰性回归过） |
| `2026-10-04-preflight-quota-probe.patch` | patch ②：mcp-proxy 转发前 sub2api 额度预检（充足放行 / 不足 402 / 计费面断连 strict 503 或 postpaid 放行；`SUB2API_CALLER_MAP` 未映射者整体跳过）。`PREFLIGHT_ENABLED` 默认 **false** | **LIVE（2026-10-05）：strict + 空 MAP**（未映射跳过；活链三态实证——充足放行/不足 402 上游零触达/断连 503 fail-closed；客户映射随 5.4 接入） |

## 二、fd 发布记录

| 版本/tag | 镜像 | 基线 | 内容 | 验收 |
|---|---|---|---|---|
| `fd-1.0.0`（tag，双仓） | `ccr.ccs.tencentyun.com/yizuo/mcp-{registry,auth-server}:sha-7fbc2d6` | 上游 **1.32.0** + cherry-pick 14 提交（Logto 线 + wire 双 patch；剔裁剪提交 `8ad0239f`/`2b36f87c`） | 独立谱系首发；保守瘦身（-16 万行：6 IdP、多云面、metrics-service、docs 大部）；CI=两套测试套 + image.yml 标准发布线 | pytest 全绿（CI 两套）+ 上线探针（鉴权 200/401/401、`/api/version=fd-1.0.0`、市场快照 diff 零丢失）+ 铸造面 e2e |
| `fd-1.1.0`（2026-10-05） | `ccr.ccs.tencentyun.com/yizuo/mcp-registry:sha-6a3acf6`（auth-server 不动，仍 `sha-676a245`） | fd-1.0.0 谱系内功能增量 | **控制台中英双语**（客户可达面：登录/壳/发现/卡片/详情连接/发布/令牌/账户；零依赖源串 key + 缺译回退英文；`localizeError` 24 处；`i18n:scan` 覆盖门禁 + 新 `frontend-test` workflow；管理面按设计保持英文） | 本地 eslint/tsc/build/scan 全绿（scan 1301/1301、0% 缺译）+ CI 双绿 + 上线探针（鉴权 200/401/401、`/api/version=fd-1.1.0`、市场快照 8/5/152 不缩水、线上产物含中文字典、真浏览器中文渲染/?lang= 覆盖与刷新持久化实证） |

| `fd-1.1.1`（2026-10-05） | `ccr.ccs.tencentyun.com/yizuo/mcp-registry:sha-c4b0994`（auth-server 不动） | fd-1.1.0 增量 | 修复 `ui_title` 渲染不一致：页头/运行时长提示/登录页品牌串统一走 `t()`（标签页已译、页头未译的割裂）；`PLAYWRIGHT_BASE_URL` 可把 e2e 指向部署（未登录用例可对生产跑） | 生产实跑：登录页冒烟绿（真 Chromium，含切换器点击 + 刷新持久化）+ 标题/页内均为「AI 网关与注册处」+ `/api/version=fd-1.1.1`；CI 三套绿 |

**版本进位惯例（本行起成文）**：`fd-x.y.z` 中 **minor = 客户可感知的功能新增**，patch = 其余（修复/内部）；每次发布在本表登记镜像 sha 与验收口径。

## 三、安全单行道登记簿（SECURITY-LANE）

规则（ADR-0017）：上游每次发版 **一周内**过 release notes；仅安全修复摘取（cherry-pick → 全量
pytest → CI 两套绿 → 标准线发布）；**功能永不并入**。每条登记：

```
| 日期 | 上游版本/提交 | 摘要 | 移植提交 | 测试凭证 | 发布 sha- |
|---|---|---|---|---|---|
```

| 日期 | 上游 | 摘要 | 移植提交 | 测试凭证 | 发布 |
|---|---|---|---|---|---|
| 2026-10-05 | `1.32.0`（收敛基线，非摘取） | 基线记录：1.30→1.32 全量安全修复随收敛继承（读面越权过滤、url_guard、forward-proxy egress 等） | fd-1.0.0 支线 | CI 两套全绿 + 上线探针 | `sha-7fbc2d6` |
| 2026-10-15 | —（自研 feature，非上游） | **fd-1.4.0 产品门面**（openspec `add-packs-product-home`）：匿名 `/` 分流出壹座·Packs 落地页（基线资产入镜像+`LANDING_ASSETS_DIR` ConfigMap 覆盖、滚动生效）；`GET /api/public/summary` 匿名聚合计数+策展精选（public+enabled 双重复核、卡片 allowlist 无后端地址、`PUBLIC_FEATURED_JSON` 策展）；品牌串 AI Gateway & Registry→Yizuo Packs（zh=壹座·Packs）；BUILD_VERSION 默认 fd-1.4.0 | fd-product-home 分支 `6225f1af`+`f8ccd531` | 本地新增 13 测试全绿（summary 7+root-split 6）+13 预存红基线 worktree 实证；i18n:scan 1301/1301；**私有池额度尽→testaction005/build-pool 快照线出片**（快照 sha-b0fb497→**sha-689ec5e**） | `sha-689ec5e`（digest 7784b015，ccr 实证） |

## 四、操作配方

**发布（标准 TCR 线，唯一正道）**：`git push github main` → GHA `image` workflow 构建
matrix（mcp-registry + mcp-auth-server）→ 推 hkccr → cheap-3 tcr-relay（≤5 分钟）回灌 ccr →
部署节点改 compose pin 拉 `ccr.ccs.tencentyun.com/yizuo/<img>:sha-<7>`。手动补发 =
Actions → image → Run workflow。操作手册：finddata 工作区 `docs/IMAGE-RELEASE.md`。

**回放历史补丁到新克隆**（仅考古用）：`git apply docs/registry-fork-patches/<patch>.patch`。

**cheap-1 本地 docker build = 已废弃**：torch 镜像 2.7GB 曾在 export 层撞满该机盘（96%），
且 containerd 内容仓被搞脏后连环 rename/extract 报错（重启 containerd 可救，勿再走此路）。

Notes:

- 旧换镜像 smoke 配方（throwaway 容器 + `lawbenchtestadmin` 自签 token + A2A 头打
  `/validate`，2026-10-03 实录矩阵）保留作考古参考；现行验收 = CI 两套绿 + 上线探针
  （鉴权 200/401/401 + 快照 diff + `/api/version`）。
- 上游 issue 候选仍在册：PingFederate-only 的 scope 重映射门是上游 #1127，同一富化路径适用
  任何 `IDP_USER_GROUP_FALLBACK` provider（logto 即是）——上游 PR #1791（logto provider，
  scs001 fork）继续养；patch ① 上游 PR = **[agentic-community#1847](https://github.com/agentic-community/mcp-gateway-registry/pull/1847)**（draft，2026-10-05，基于 upstream/main 14f8589a，patch-key 三件套 38 测试绿）。
