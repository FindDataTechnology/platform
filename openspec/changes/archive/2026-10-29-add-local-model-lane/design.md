# Design: add-local-model-lane

## Context

侦察坐实：车道**管线**已经全通——用户 provider（`llm-providers.js`）经
`buildUserProviderEntries`/`credentialRefsForUserProviders` 写入 dsh profile
（`dsh-profile.js:222/357`），cell 聊天与 fleet runner 子进程（共享 ~/.dsh 种子）
同源消费；模型发现/探活/分类器（sync）也已存在。真正挡住「指向本机模型」的
只有三件小事：`requireKey: true`、无预设、keyless 探活行为未定义。本设计因此
刻意**小**：不加新端点、不动分类器、不碰 reserved 路由。

## Goals / Non-Goals

**Goals:**
- keyless 本地 provider 一等公民（Ollama/LM Studio 预设 + `auth` 形态）。
- 探活/同步对 none 不带凭据；推理请求同样不带（推理走 dsh 的凭据解析——none
  的 provider 在 `.credentials.yaml` 不写条目，dsh 侧自然不带 Authorization）。
- 舰队继承从「应该行」变成「断言行」。

**Non-Goals:**
- 本地推理服务本身的安装/管理（Ollama 装不装是用户的事）。
- 非_OpenAI 兼容_协议（native Ollama API、llama.cpp server 原生协议）——
  openai-completions 一张票够用，Ollama/LM Studio 都兼容。
- 多机共享本地模型；reserved env 路由改动；模型同步分类器改动。

## Decisions

### D1 auth 是 provider 的形态字段，不是全局开关

`auth: "bearer" | "none"` 挂在 provider 记录上（缺省 bearer，零迁移）。理由：
一台机器可以同时有云端 lane（要 key）和本地 lane（无 key），形态必须随
provider 走。落点：`validateInput` 的 `requireKey` 改为 `auth === "bearer"` 时
必填；`credentialRefsForUserProviders` 对 none 的 provider **不写**凭据条目
（`.credentials.yaml` 干净）；探活/同步/（经 dsh 的）推理一律不带 Authorization。
替代项「baseUrl 是 loopback 就自动免 key」——隐式行为比显式字段难排查
（用户换了非 loopback 的局域网机器就静默变回带 key），否决。

### D2 预设只填表单，不建记录、不做自动发现服务

「本地模型」预设 = 创建面的表单预填（baseUrl/auth/协议）。不做「扫描本机在跑
的推理服务」——那是后台探测服务（端口扫描/进程探测），隐私与复杂度都不值；
Ollama 的默认端口是稳定常识，预设填上即可，`test` 按钮一键验证可达性。替代项
「自动发现本机 Ollama」被否决：引入常驻探测面，收益只是少填一个 URL。

### D3 舰队继承立为可断言要求，而非口头「应该行」

用户 provider → dsh profile 的写入是单源（`writeLlmProfile` 一条路），runner
种子 home 从同一 profile 起步——继承在机制上成立。但「成立」与「被断言」差
一次事故：立一条 spec 要求（路由文件含该 provider 路由、none 无凭据条目）+
一条单测（写 profile 后断言 runner 种子侧可见）。若未来有人给 runner 单独
建 profile，这条会红。

### D4 模型家族元数据走既有合并纪律，本地 id 不特判

sync 合并 serving 模型时带 family-table 默认元数据；本地模型 id（llama3、
qwen2.5…）多数不在家族表里 → 落默认家族。**不特判**：家族表是运营面（可后续
补行），车道可用性不依赖家族分类。若发现某本地 id 被家族逻辑误伤，按既有
家族表补行流程走。

## Migration

- 零迁移：auth 缺省 bearer；`.credentials.yaml` 对既有 provider 的写法不变。
- 回滚 = 撤 auth 分支与预设 UI；记录里的 auth 字段被忽略即回到旧行为。

## Verification

- 单测：keyless 创建（无 key 成功/缺 auth 字段旧记录=bearer）；探活对 none
  不带 Authorization（拦截 fetch 断言头）；`credentialRefsForUserProviders`
  对 none 不产出凭据条目；**runner 种子断言**（写 profile 后，种子侧路由含
  本地 provider、无凭据条目）——D3 的落地证据。
- e2e：创建面选 Ollama 预设 → 提交 → Models 页卡片可见（fast 车道，mock fetch）。
- 手动：本机 Ollama 起一个模型 → 建卡 → 设默认 → chat 一轮 + fleet 部署一岗
  跑一轮，两面眼见（台账截图）。
