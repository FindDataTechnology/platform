# dsh-llm-providers Specification

## Purpose
How upstream LLM providers are wired into the dsh runtime: the 萬星词元 (sub2api) OpenAI-compatible endpoint is registered as a dsh `ctx.llm` adapter plugin under provider id `ciyuan` (legacy id `volces` accepted read-only during migration), API keys are routed through dsh's hot-reloaded `dsh-credentials-local` store so a rotated key reaches the next request without a restart, a hosted cell's bound ciyuan account key overrides the deployment seed for the ciyuan provider's env ref, and every generated provider profile carries a bounded exponential-backoff retry policy for transient failures.

## Requirements

### Requirement: A bound ciyuan account overrides the deployment seed per hosted cell

In hosted deployments where each cell serves exactly one identity, the credential store writer SHALL, when that identity has a bound ciyuan account key, write it as the value of the ciyuan provider's env ref (`LLM_PROVIDER_KEY_FINDDATA`) instead of the deployment seed from `llm-providers.json`. The override SHALL ride the same hot-reloaded store, so it reaches the **next LLM request** without a dsh restart; removing the binding (disconnect or stale) SHALL restore the seed value on the next store write. In single-process deployments serving several identities from one store, the writer SHALL NOT apply any per-identity override.

#### Scenario: bound key wins over the seed in a cell

- **WHEN** the cell's identity binds a ciyuan account and the credential store is rewritten
- **THEN** `.credentials.yaml` carries the user's key under `LLM_PROVIDER_KEY_FINDDATA`
- **AND** the next LLM request uses it with no dsh restart

#### Scenario: unbinding restores the seed

- **WHEN** the identity disconnects (or the key is marked stale) and the store is rewritten
- **THEN** `LLM_PROVIDER_KEY_FINDDATA` equals the `llm-providers.json` seed again

#### Scenario: shared single-process store is never overridden

- **WHEN** the server runs single-process for several identities
- **THEN** no identity's ciyuan key is written into the shared credential store

### Requirement: 词元 provider is registered as a dsh llm adapter plugin（provider id `ciyuan`）

服务 SHALL 把萬星词元（sub2api）的 OpenAI 兼容端点注册为 dsh `ctx.llm` adapter，
provider id SHALL 为 `ciyuan`，并出现在模型选择器的暴露集合中。

#### Scenario: ciyuan adapter loaded at startup
- **WHEN** 服务启动且 `LLM_API_KEY` 与 `LLM_BASE_URL` 均已配置
- **THEN** dsh 运行时加载该 llm adapter，其模型出现在 `list_models` 中

#### Scenario: ciyuan not configured
- **WHEN** `LLM_BASE_URL` 未配置
- **THEN** 该路不生成 providers，服务照常启动并提供静态与 REST 面

### Requirement: 未配置的 LLM 路 MUST NOT 回退第三方端点

`LLM_BASE_URL` 缺失时 MUST NOT 使用任何内建的第三方默认端点：一个缺失的 env 不得把
客户请求连同平台密钥发往第三方。

#### Scenario: 不配置时不发第三方请求
- **WHEN** `LLM_BASE_URL` 未配置
- **THEN** 不向任何内建第三方地址发出请求（配置里 MUST NOT 出现 `|| "<某第三方 URL>"`
  形态的兜底值）

### Requirement: 旧 provider id 作为只读别名被接受

旧 provider id `volces` SHALL 作为只读别名被接受，使存量 cell 的 settings 与
`llm-default.json` 无需人工改写即可继续工作；写入路径 MUST 只产生 `ciyuan`。

#### Scenario: 旧 id 仍可读（迁移窗口）
- **WHEN** 存量 cell 的配置里写着 `provider: volces`
- **THEN** 读取方将其解析为 `ciyuan`，会话与模型选择不受影响
- **AND** 之后任何写入都只写 `ciyuan`

### Requirement: 保留路由判据不依赖 provider id 字面量

判断某 provider 是否为 env 驱动的保留路由时，判据 SHALL 取其「保留」语义
（如 `reserved` 布尔），MUST NOT 比较 provider id 字面量——这样 id 变更不需要跨前后端
同步改字面量。

#### Scenario: id 变更不影响保留路由识别
- **WHEN** provider id 被重命名
- **THEN** 前后端仍按「保留」语义正确识别该路由，无需同步改字面量

### Requirement: Provider credentials are resolved per-request from a hot-reloaded store
The server SHALL route upstream provider API keys (`LLM_API_KEY`) into dsh's `dsh-credentials-local` hot-reloaded credential store (`.credentials.yaml`, 0600 perms) rather than reading them once from `process.env` at boot. A rotated key SHALL reach the **next LLM request** without a dsh process restart, because `dsh-credentials-local` resolves the key per request and hot-reloads the file. The store SHALL be seeded from `process.env` on first run when the file is absent.

#### Scenario: rotated key takes effect without restart
- **WHEN** an upstream provider API key is changed (written to `.credentials.yaml`)
- **THEN** the next LLM request SHALL use the new key
- **AND** the dsh process SHALL NOT be restarted

#### Scenario: credential store seeded from env on first run
- **WHEN** the server starts and `.credentials.yaml` is absent
- **THEN** the server SHALL seed it from the configured `process.env` keys

### Requirement: Generated provider profiles carry a transient-error retry policy

Every LLM provider profile the platform generates (the env-driven default route and every user-added route from the Models page) SHALL carry a retry policy that retries transient request failures with bounded exponential backoff. The retryable set SHALL include rate-limit rejections, server errors, timeouts, transport failures, empty responses, and the adapter's unrecognized-error fallback bucket (a gateway whose rejection wording defeats message-pattern classification must still be retried). The policy SHALL be bounded (finite attempts, capped delay, jittered) — never unbounded retrying. Policy changes SHALL take effect via the settings hot-reload path without a runtime restart.

#### Scenario: concurrency-limited request is retried, not fatal
- **WHEN** the gateway rejects a model request with a concurrency-limit rejection whose text contains neither a status code nor the words "rate limit"
- **THEN** the request SHALL be retried with backoff up to the configured finite budget
- **AND** the turn SHALL complete normally if a retry succeeds

#### Scenario: policy applies to user-added routes
- **WHEN** a user adds or edits a provider on the Models page
- **THEN** the generated profile for that route SHALL carry the same retry policy semantics as the default route

#### Scenario: policy reaches the runtime without restart
- **WHEN** the generated settings section changes a provider's retry policy
- **THEN** the running runtime SHALL pick up the new policy via settings hot-reload
- **AND** the next failed request SHALL be governed by the new policy

### Requirement: profile 生成器的自检必须可运行且可失败

`node dsh-profile.js` 这个自检 SHALL 能在真实入口位置跑完，并且任一被检查的不变量被违反时 MUST 以非零退出码结束。

- 模块图 SHALL NOT 形成「async 入口 + 静态回边」的环：入口模块（`dsh-profile.js`）带 top-level await，任何被它懒加载、又静态 import 它的模块 MUST 改为依赖叶子模块。
- 自检里的每条不变量 SHALL 以抛错方式表达（`check()`），MUST NOT 只用 `console.assert`（只打日志、退出码仍为 0 的断言不构成闸）。
- 自检 SHALL 在结束时清掉自己制造的产物（自检 agent 的 preset 定义与其 patch 行、pack 技能根、临时 DB），MUST NOT 在 `$DSH_HOME` 里留下指向不存在实体的行。

#### Scenario: 入口即 async 模块时不发生死锁

- **WHEN** 以 `node dsh-profile.js` 运行（`dsh-profile.js` 是入口，且它带 top-level await）
- **THEN** 进程 SHALL 跑完整段自检并以 `exit 0` 结束
- **AND** MUST NOT 出现 `Detected unsettled top-level await`

#### Scenario: 不变量被违反时自检变红

- **WHEN** 生成的 provider 块里重新出现路由级 `reasoning:`（或恢复那条静态回边）
- **THEN** 自检 MUST 以非零退出码结束，并打印被违反的不变量
- **AND** 验证脚本 `scripts/test-dsh-profile-self-check.mjs` MUST 报红

#### Scenario: 自检产物不残留

- **WHEN** 自检正常跑完一次
- **THEN** `$DSH_HOME` 里 MUST NOT 留下自检 agent 的 preset 定义或它的 patch 行
- **AND** 隔离运行时，所有写入 SHALL 落在传入的 `$DSH_HOME` 内

### Requirement: 文档与代码对配置契约的描述必须与实况一致

面向开发者的说明文件（仓库内的协作说明、README、部署说明等）在描述环境变量与默认值时
SHALL 与代码里实际读取的名字一致。MUST NOT 描述不存在的变量，MUST NOT 声称存在内建的
兜底密钥（除非确实存在且被明确标注为开发用）。

理由：`CLAUDE.md` 曾声称 `VOLCES_API_KEY` / `VOLCES_BASE_URL` 存在、且 `server.js` 内烘焙了
fallback key；实测这些变量在代码里零命中、也没有烘焙 key。照着它工作的人会建立错误的
系统认知，而没有任何机制会发现这个偏差。

#### Scenario: 文档里的变量名可被代码验证
- **WHEN** 检查文档中声明的每个环境变量名
- **THEN** 每个名字都能在代码的读取点找到对应（或该条目被标注为「历史/已移除」）

#### Scenario: 不声称不存在的兜底凭据
- **WHEN** 文档提到内建兜底密钥
- **THEN** 该密钥要么确实存在，要么该表述被删除
