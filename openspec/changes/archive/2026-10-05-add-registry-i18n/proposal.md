# add-registry-i18n

## Why

注册处（registry 控制台）是外部客户看市场的正门，但界面全英文；客户主体是中文浏览器用户，登录后的市场浏览、连接、发布、令牌这些高频路径上英文抬高使用门槛。仓内甚至已经零散出现硬编码中文（`Login.tsx` 登录按钮、auth_server 配额 wire 消息），说明需求真实存在、只是没有系统性支持。

现在做的时机：registry 已收敛为 fd 独立谱系（ADR-0017，上游只走安全单行道），功能改动不再与上游合并冲突；标准 TCR 发布线已就绪，一次机制 + 分档覆盖就能上线。

## What Changes

- **引入轻量 i18n 机制**：零依赖 `t()`（英文源串为 key），`zh` 字典按域拆 4 个 JSON（common/shell/discover/forms），缺译回退英文——任意中间状态可上线。
- **语言探测与切换**：`navigator.language` 自动探测（`zh*` → 中文）、`localStorage` 记忆、`?lang=` 覆盖；切换器在顶栏（`Layout` Header）与登录页。`<html lang>`、`document.title` 随语言动态化。
- **T1+T2 客户可达面全量接入**：登录/壳（Layout/Sidebar）/发现与搜索/卡片/详情/连接弹层/外部源/自定义实体/虚拟 server 视图；发布流（RegisterPage + 表单字段组）/令牌页/账户页。
- **运行时错误消息本地化（前端层）**：`utils/apiError.ts` 扩展 `localizeError` —— 七类状态码/网络错误映射中文通用文案 + 高频后端 detail 精确映射，其余保留英文 detail 作副行；后端代码零改动。
- **覆盖门禁**：新增 `npm run i18n:scan`（未译清单 + 缺译率）与 `frontend-test` CI workflow（npm ci + lint + build + jest + scan，报告存 artifact）；三条 zh e2e 冒烟（首屏/登录/连接弹层）。
- **收编既有硬编码**：`Login.tsx`「寻数科技账号登录」改为 `t()` 并补英文。
- **发布**：`fd-1.1.0`，`fd/i18n-ui` 分支 → merge main → 标准 TCR 线；发布记录补一行版本进位惯例（minor = 客户可感知功能，patch = 其余）——谱系文档级，不改 spec。
- **Logto 托管页（条件性）**：先在 Logto 管理台开启/确认简体中文并人工验证托管页跟随；验证不跟随才触发 `ui_locales` 全链透传（登录页 → registry `/auth/{provider}` → auth_server `/oauth2/login` → authorize URL，附白名单校验与测试）。

## Non-Goals

- 管理面不译：`/settings/*`（IAM/审计/应用日志/联邦管理/Virtual MCP 设置/系统配置/数据导出/Registry Card）。管理员切中文后管理页仍英文的混合体验，本次接受。
- 目录内容（L3）不译：server/agent/skill 的条目名、描述、标签属发布者数据，单独评估（schema 字段或翻译 overlay，另立 change）。
- 后端数据面消息与 `Accept-Language` 协商不做（wire 中文消息维持现状）；landing 静态页、CLI、文档不译。
- 跨设备语言记忆（Logto 用户元数据）不做，本次仅 `localStorage`。

## Capabilities

### New Capabilities

- `registry-console-i18n`: 注册处控制台的语言探测与切换、缺译回退与覆盖门禁、运行时消息本地化、既定中文术语、翻译边界、验收与回归（前端门禁 + zh 冒烟 + 发布探针）。

### Modified Capabilities

（无——registry-lineage 等现有 spec 的行为要求不变；版本进位惯例落在谱系维护文档而非 spec。）

## Impact

- **代码仓**：`~/code/mcp-gateway-registry`（fd 独立谱系）
  - 新增：i18n 机制（contexts + `t()` + 字典）、`i18n:scan` 脚本、`.github/workflows/frontend-test.yml`
  - 修改：T1/T2 客户面组件约 40 个文件的机械包裹（`t()`）、`utils/apiError.ts` 扩展、`Login.tsx` 收编、`package.json` 脚本；不改 JSX 结构，降低安全单行道 cherry-pick 摩擦
  - 不触碰：`registry/*.py`、`auth_server/*`（除 Logto 退路触发）
- **部署**：`fd-1.1.0` 镜像经 GHA → hkccr → tcr-relay → ccr 标准线，cheap-1 compose 钉版滚动
- **文档/账本**：`docs/registry-fork-patches/README.md` 发布记录 + 版本进位惯例；`docs/registry-maintenance.md` 如有需要同步
- **外部配置（仓外）**：Logto 管理台语言设置一次确认