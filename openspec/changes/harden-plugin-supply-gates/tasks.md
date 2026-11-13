## 1. 路由独占断言（先做，其余三条依赖它的形状）

- [x] 1.1 `dsh-profile.js` 新增 `assertRouteExclusivity(rows) → violations[]`（纯函数，无 I/O）：按 `name` 形态 + `config` 形态判定"会注册模型路由的行"，返回违规清单（行 id、name、来源）；验证：`scripts/test-plugin-route-exclusivity.mjs` 四条用例（合法 / 第三方 llm 行 / 只有第三方行 / 平台行 + 第三方行）
- [x] 1.2 写盘前调用：`writeLlmProfile` 组装完 `kept` 后先断言，违规即抛出具名错误且不写盘；验证：同文件断言"违规时文件 mtime 不变"
- [x] 1.3 启动前调用：`dsh-bridge.js` 在 ready 之前对合成树再断言一次；验证：注入违规行后启动失败，且错误文本含行 id 与来源
- [x] 1.4 **先证明能红**：用当前代码跑 1.1 的用例，第三方 llm 行必须被判定为违规（若当前实现恰好也拦住了，记录证据并调整本变更范围）

## 2. 工具面封顶覆盖插件工具

- [x] 2.1 **口径已改（design D3'）**：实测工具闸只按 MCP server 名索引、插件工具无 server 键、`plugins/list` 不报工具名 ⇒ v1 不接假接缝，改为在供给白名单层禁止 `contributes: ["tool"]`；验证：`scripts/test-plugin-contribution-class.mjs` 断言声明 `tool` 的条目被拒并指名该类别
- [ ] 2.1b 若将来 dsh 暴露工具清单 RPC：再做"声明即白名单，其余默认拒"的实闸，并补正/反向用例；在此之前不得把 `tool` 从禁止集移出

## 3. 凭据面出片期检查

- [x] 3.1 凭据键名表集中一处（`PLATFORM_CREDENTIAL_KEYS`）并新增 `scripts/check-bundle-credentials.mjs`（扫的是会合成进每个 profile 的**声明**，不扫桥代码避免噪声）；验证：`test-plugin-credential-surface.mjs` 7 条（任意深度命中并给字段路径 / 前缀形态 LLM_PROVIDER_KEY_* / 相邻合法名不误报 / 键表无死条目 / 真仓当前干净 / CLI 红与绿两种）
- [x] 3.2 出片前置接入两处：桌面 `predist` 链首 + 镜像构建 `COPY . .` 之后（**不能更早**——scripts/ 那时还不存在）；验证：`node scripts/check-bundle-credentials.mjs` 在真仓返回 clean（4 份声明）、接入不改任何产物字节
- [x] 3.3 **发现并修掉一个真洞**：`buildScrubbedEnv` 原本只擦 `LLM_API_KEY`，`FACET_INTERNAL_TOKEN`/`PACK_USAGE_TOKEN`/`SUB2API_*` 等会随进程环境交给 dsh 子进程（bundle 可读）；现由 `lib/platform-credential-keys.js` 一处定义、两个读者（构建闸 + 子进程擦除）共用；验证：`test-plugin-child-env-scrub.mjs` 4 条（凭据键全消失 / 非平台键保留 / 干净环境返回 null / 匹配器覆盖全部名单与前缀）

## 4. 贡献类别声明

- [x] 4.1 新增 `dsh-matrix/plugin-supply.json`（`contributes[]`，v1 允许 skill/ui/service）+ `scripts/check-plugin-supply.mjs` 双向一致性校验（模板里 composed 的必须有声明；声明了的必须 composed；`@deepseek-ai/*` 上游运行时豁免）；接入 predist 与镜像构建；验证：`test-plugin-supply-agreement.mjs` 8 条（未声明即未审 / 声明无处合成 / 无允许类别 / 上游豁免 / 缺 bundles 数组即拒 / 真仓干净 / CLI 红绿）
- [x] 4.2 越界即拒：`lib/plugin-contribution-spec.js` 定义允许集（skill/ui/service）与四个禁止集及各自理由；声明 `tool`/`llm`/`credential`/`channel` 一律拒并指名字段路径；验证：`test-plugin-contribution-class.mjs` 9 条（含未声明不得视为无害、缺省清单=诚实空）
- [x] 4.3 例外白名单：`dsh-matrix/route-exceptions.json`（`name`/`reason`/`approvedBy`/`expiresAt` 四字段必填，按**包名**匹配，不认行 id）+ `lib/route-exceptions.js` 读取器；写盘与启动两处都先过滤再断言；出片期 `check-plugin-supply.mjs` 同时校验台账（缺字段、已过期都红）；验证：`test-plugin-route-exceptions.mjs` 13 条（有效放行 / 过期不放行且报 EXPIRED / 缺字段不放行 / 行 id 冒充包名失效 / 文件不可解析=不放行 / 真仓台账为空且合法）+ `test-plugin-supply-agreement.mjs` +4 条台账用例

## 5. 收尾

- [x] 5.1 观察期证据（2026-11-12，未开关即取证）：不从现网抓日志，而是**把现网真实合成结果拉回来用本仓断言离线判**——`kubectl exec` 收集 platform pod 上全部 `*/dsh/profiles/platform/cordis.patch.yml`（34 份）+ demo pod（1 份），共 35 份 patch / 66 行，其中 24 份含平台自己的 `llm-pi-ai`、7 份含 `spill-policy`；`findRouteExclusivityViolations` 判定 **0 违规、0 不可解析**。即：切 fail closed 不会掐断任何一台现存 cell（观测的是被判定对象本身，不是邻近代号）
- [x] 5.2 `openspec validate harden-plugin-supply-gates --strict` 绿。分批全量扫（587 文件，每批 40，排除了 4 个已证既有红套件：`test-agent-serving` / `test-connector-credentials` / `test-connector-binding-migration` / `test-deployment-secrets`）：**5128 条 / 5076 过 / 27 挂**；把 27 挂按名字定位到 19 个文件，再用**原始 HEAD 工作树逐文件同口径对照**（`--test-timeout=20000` + 硬超时）逐条归因：
  · **我的回归 = 0**。唯一一条 work 侧多出的红是 `test-design-lint` 的 `ConsoleBody.tsx side-tab-border 1>0`（本变更 unchecked 期的 Console 组件），已把 `border-l-2`→`border-l`（1px 发丝线，规则明写允许）；修后该文件只剩他人未提交的 `InputRequestCard.tsx 3>0`。
  · 既有红（HEAD 上同样红）：`test-agent-studio` 11/1、`test-cron-round-rotation` 2/3、`test-opening-gates` 2/3、`test-persona-park-lane` 4/5、`test-empty-turn-billing` 2/2、`test-deploy-roster-gate` 1/1、`test-deploy-lock` 两条 20s 超时（两树一致）、`invest-trading-fleet.seed.json` 缺 i18n.en 覆盖。
  · 他人未提交文件的红（非本变更）：`server/auth.js` 的 INTERNAL_BRIDGES 未同步规范表 → `test-auth-trust-boundary` 5/1 vs HEAD 6/0；`add-zhiyu-mobile-clients`(23/23) 全勾未归档 → `test-openspec-archive-hygiene`；未跟踪的 `personal-staff-fleet.seed.json` 空 i18n → `test-official-locale-gate` 3/2 vs HEAD 4/1；`InputRequestCard.tsx` → `test-design-lint`。
  · 另有若干在 30s 批扫里超时、但单独跑（`--test-force-exit`）两树全绿的（如 `test-agent-runner` 72/72、`test-cell-gateway` 2/2、`test-deploy-harness-gate` 4/4），属批扫噪声。
- [x] 5.3 文档：`docs/ecosystem-curation.md` §7.1 新增"贡献类别与越界即拒"（允许 skill/ui/service；禁止 tool/llm/credential/channel 及各自理由；两个出片门；例外台账四字段与到期复审），指向 `openspec/specs/plugin-supply-gates/`
