# add-registry-i18n — Design

## Context

见 `proposal.md` 的 Why/What。设计相关的现状约束：

- **前端形态**：React 18 + Vite + TS + Tailwind，`frontend/src` 约 167 个 ts/tsx、4.1 万行（非测试）；无任何 i18n 基础设施。构建在 `docker/Dockerfile.registry` 的 node 多阶段里完成，产物落 `/app/frontend/build`。
- **静态资源契约**：`vite base='/'` + `registry/main.py` 对 index.html 的 `="/static/` 重写 + nginx `ROOT_PATH` 路径前缀三段耦合，**不能做语言路径前缀**（`/zh/...`）。
- **CI 现状**：两套测试（Registry / Auth Server Test Suite）触发于 `main, develop, fd-*`，**均不跑前端**；`image` workflow 仅在 `push main` 时构建镜像（其前端构建是唯一的编译兜底）。
- **谱系约束**：ADR-0017 独立谱系，上游只摘安全修复——本变更是谱系自有功能，不受"功能永不并入"限制，但机械包裹方式要控制未来 cherry-pick 摩擦。
- **既有中文两处**：`frontend/src/pages/Login.tsx:112`（登录按钮硬编码）、`auth_server/preflight_quota.py`（配额 wire 消息，数据面，本次不动）。
- **仓库文化**：AGENTS.md 要求"最小复杂度、直白可读"；前端约定命令为 `npm run lint && npm run build`（jest 已存在但不在 CI）。

## Goals / Non-Goals

**Goals:**

- 一套**可渐进覆盖**的 i18n 机制：任意翻译进度都可上线、缺译安全回退、覆盖缺口可量化（对应 `specs/registry-console-i18n/spec.md` 全部六条要求）。
- 与谱系治理兼容：最小 diff、机制独立成文件、发布走标准 TCR 线（fd-1.1.0）。
- 前端质量门禁补齐到 CI（本次引入的字典一致性天然需要自动门）。

**Non-Goals:**

- 不引入 i18n 框架依赖、不重排组件 JSX 结构、不动路由与静态资源布局。
- 不做后端 locale 协商（`Accept-Language`）、不做数据面消息、不做目录内容翻译（spec 的"翻译覆盖边界"已定）。
- 不做跨设备偏好同步（仅 localStorage）。

## Decisions

**D1 机制：零依赖 `t()` + 英文源串为 key**（备选：react-i18next 源串 key / i18next 语义 key）
理由：单一目标语言、无复数/性别/ICU 需求；源串 key 使"缺译回退英文"天然成立（`t(src)` 查不到即返回 `src`），无 key 命名开销、代码可读；零依赖契合仓内极简文化；diff 最小。语义 key 方案（`discover.card.download`）把翻译与代码解耦但重写全部调用点、可读性差，收益（多语言扩展/翻译平台）当前为零，未来若需要，迁移成本主要落在调用点（届时才付）。
机制组成：`I18nProvider`（挂在 `ThemeProvider` 同级）+ `useI18n()` + `t(src, vars?)`（支持 `{name}` 插值）+ 同形异义的显式覆盖口子（`t('Server', { context: 'nav' })`）。

**D2 字典组织：按域拆 4 个 JSON**（`common/shell/discover/forms`），近似 `Record<string, string>`，键=英文源串
理由：单文件到 900 条会变大且冲突面集中；按域拆分与任务分组（T1/T2）对齐；扫描脚本按域输出缺译率。

**D3 语言探测与持久化**：`navigator.language` 探测（`zh*` → zh，否则 en）→ `localStorage` 记忆 → `?lang=` 覆盖并写回
理由：无服务端状态、零成本；URL 参数读取要兼容 `getBasename()`（`utils/basePath.ts`）。备选（cookie / Logto 用户元数据跨设备）留后续，不改变机制。

**D4 切换器位置**：`Layout.tsx` Header（ThemeToggle 旁）+ `Login.tsx`（登录前可切）
理由：客户不可达设置页（齿轮 admin-only），这两个入口是仅有的公共位置；`<html lang>`、`document.title` 随语言设置。

**D5 L2 运行时消息：前端 `localizeError`**（备选：后端 `Accept-Language` 全量协商）
理由：客户高频撞到的错误收敛为七类（网络/401/403/402/404/429/5xx）+ 少量业务 detail；在 `utils/apiError.ts` 现有 `extractErrorDetail` 之上包裹：命中映射 → 中文；未命中 → 原英文 detail 作副行保留（排查不丢线索）。后端零改动；数据面 wire 消息与协商后续单独提案。

**D6 测试策略：默认 en 保绿 + zh 定点冒烟**
既有 jest 快照与 admin 向 Playwright e2e 全按 en 源串断言 → 测试环境固定 `locale=en`，不为翻译改既有断言；新增：机制单测（探测/持久化/覆盖/插值/回退）+ 三条 zh 冒烟（首屏/登录/连接弹层，Playwright 固定 zh）+ `i18n:scan` 的 fixture 测试。

**D7 CI 门禁：新增 `frontend-test` workflow**（备选：维持本地约定 / 塞进 image workflow）
理由：字典漂移、key 拼错、缺译累积是静默腐烂型风险，扫描脚本正是理想门禁；本地约定无人兜底，image workflow 发版前才发现太晚。workflow 只跑校验不产镜像：`npm ci → lint → build → jest → i18n:scan`，扫描报告存 artifact；触发条件与被合并前检查对齐（`main, develop, fd-*`）。

**D8 Logto 分级**：任务先做零代码验证（Logto 管理台开启/确认简体中文 + 人工走一遍登录，检查托管页是否跟随浏览器语言）；不跟随才触发退路实现：`Login.tsx` 传 `i18n.language` → registry `/auth/{provider}` 白名单透传（`zh-CN/zh/en` 枚举校验，防注入）→ `auth_server/server.py` `/oauth2/login/{provider}` 注入 `auth_params['ui_locales']`（`server.py:6238` 的 `urlencode` 点）→ 测试。仓外配置一次，仓内实现条件触发。

**D9 版本与发布**：`fd-1.1.0`（成文惯例：minor = 客户可感知功能，patch = 其余；登记进发布记录）；分支 `fd-i18n-ui` —— 注意必须用**连字符**形式：工作流的触发模式是 `fd-*`，GitHub 的 `*` 不匹配 `/`，`fd/i18n-ui` 这类斜杠分支**不会触发任何测试**（实施中实测发现并改名）→ merge `main` → image workflow → hkccr → cheap-3 relay → ccr → cheap-1 compose 钉版滚动。

**D10 收编既有硬编码**：`Login.tsx` 的「寻数科技账号登录」改 `t('Sign in with FindData account')`（en 给出 "Sign in with FindData account"）；`auth_server` 配额中文消息保持不动（数据面，属 D5 非目标）。

**D11 谱系摩擦控制**：机制只加新文件；组件内一行包裹（import + `t()` 包住字面量），不重排 JSX、不动 props 结构；字典与调用点分离。未来上游安全修复若撞到同一行，手工解冲突，接受偶发成本。

## Risks / Trade-offs

- [安全单行道 cherry-pick 冲突] → 机械包裹 + 新文件隔离（D11）；冲突面局限在被摘提交触碰的少数文件。
- [同形异义/源串变更产生译文孤儿] → 扫描报告按域列出未译与孤儿；术语表统一；字符串变更走"改源串即回落到未译"的自然流程。
- [既有快照/e2e 误伤] → 测试固定 en（D6）；如个别用例断言依赖语言变量，显式固定 en 处理，不改语义。
- [半中文观感] → 关键路径 100% + 总体 <5% 门禁 + 发布前中文抽检（spec 验收与回归）。
- [词典体积进 bundle] → 4 个 JSON 体量小（估 <60KB 原始）；必要时按路由懒加载，属实现备选不动机制。
- [管理员混合语言被当作缺陷] → spec「翻译覆盖边界」已声明为已知并接受；T3 后续 change 消化（机制已铺，届时候只加字典）。
- [Logto 验证不过且退路遗漏] → 任务 5.x 显式挂条件项；上线探针只断言控制台自身，不依赖 Logto 结果。
- [门禁阈值过严拖慢 T1] → 阈值参数化（扫描脚本支持 `--max-missing`），定 5% 起始，T1 完成后按实测校准（不改 spec 行为）。

## Migration Plan

1. 实现顺序：机制（字典骨架 + Provider + 切换器）→ T1 覆盖 → T2 覆盖 → L2 映射 → 扫描脚本 + `frontend-test` workflow → 翻译补齐与抽检。
2. 发布：`fd/i18n-ui` 全绿 → merge `main` → image（`fd-1.1.0`）→ relay → ccr → cheap-1 钉版滚动；发布记录与版本惯例登记。
3. 上线探针：中文首屏渲染 + 语言选择刷新后保持（现有探针矩阵扩展两条断言）。
4. 回滚：镜像钉版回退 `fd-1.0.0` 的 sha 即可——纯前端、无数据迁移、无服务端状态（语言选择仅 localStorage），回滚零风险。

## Open Questions

- Logto 托管页是否遵守浏览器语言 / 租户是否已配简体中文：任务中验证后即答；不影响方案（退路已定）。
- 5% 缺译阈值的最终取值：T1 完成后按扫描实测微调（仅门禁参数）。