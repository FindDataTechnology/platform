# llm-model-management Specification Delta

## MODIFIED Requirements

### Requirement: Server exposes LLM provider CRUD endpoints

The server SHALL expose admin-gated CRUD endpoints for user-managed LLM
providers (`GET/POST /api/llm/providers`, `PUT/DELETE /api/llm/providers/:id`).
A provider record SHALL carry `name`, `baseUrl`, `type` (`openai-completions`),
a model roster, and **an `auth` form: `"bearer"` (default) or `"none"`**. When
`auth` is `"bearer"`, creation SHALL require an API key (existing behaviour);
when `auth` is `"none"`, the API key SHALL be optional AND the credential
store SHALL hold an EMPTY value for that provider (the env ref stays resolvable
for the dsh route, but no key material exists to leak). The server's own
outbound requests (probe, sync) SHALL omit the `Authorization` header entirely;
inference requests go through dsh's credential resolution with the empty value
(local model servers ignore the empty Bearer). Records written before this change (no `auth`
field) SHALL be treated as `"bearer"` with zero migration. Providers whose
`baseUrl` points at loopback (127.0.0.1/localhost) SHALL be legal first-class
lanes — the local model lane — with the same CRUD, probe, sync, and
default-model-pointer rights as remote providers.

#### Scenario: keyless local provider creates without a key

- **WHEN** an admin creates a provider with `auth: "none"`, baseUrl
  `http://127.0.0.1:11434/v1`, and no API key
- **THEN** creation succeeds and `GET /api/llm/providers` exposes the record
  with `auth: "none"` and no key material

#### Scenario: legacy records stay bearer

- **WHEN** a provider record written before this change is read
- **THEN** it is exposed with `auth: "bearer"` and its behaviour is unchanged

#### Scenario: loopback baseUrl is a legal lane

- **WHEN** an admin creates a provider whose baseUrl points at 127.0.0.1
- **THEN** creation, probe, sync, and the default-model pointer all behave
  exactly as for a remote provider

#### Scenario: list providers

- **WHEN** the client sends `GET /api/llm/providers`
- **THEN** the server SHALL return every provider with its id, name, baseUrl,
  hasKey, type, models, and lastTest — plus the `auth` form
- **AND** SHALL NOT include the apiKey in any form

#### Scenario: add a provider

- **WHEN** the client sends `POST /api/llm/providers` with a valid body
- **THEN** the server SHALL validate the name is unique, write the patch to
  settings.yaml
- **AND** restart dsh with the new profile
- **AND** return the new provider record
- **AND** broadcast a `models` WS event so the sidebar model selector updates

#### Scenario: delete the only provider is rejected

- **WHEN** the client sends `DELETE /api/llm/providers/:id` and `:id` is the
  only remaining provider
- **THEN** the server SHALL return HTTP 409 with
  `{ error: "cannot delete the only configured provider" }`
- **AND** no settings.yaml change SHALL be made

## ADDED Requirements

### Requirement: 本地模型预设进创建面

provider 创建面 SHALL 提供「本地模型」预设（至少 Ollama
`http://127.0.0.1:11434/v1` 与 LM Studio `http://127.0.0.1:1234/v1` 两形态）：
选中预设即填入 baseUrl、协议（openai-completions）与 `auth: "none"`，并附一行
可达性说明（「确认本机推理服务在运行」）。预设 SHALL NOT 自动创建记录——
提交仍是一次显式创建。创建面 SHALL 暴露 auth 形态选择（预设填充后可改）。

#### Scenario: Ollama 预设一键填充

- **WHEN** 用户在创建面选中「Ollama」预设
- **THEN** baseUrl/auth/协议被预填，提交后得到一个 `auth: "none"` 的本地 provider

#### Scenario: 预设不自动建记录

- **WHEN** 用户选中预设但未提交
- **THEN** 不产生任何 provider 记录

### Requirement: 探活与同步对无凭据车道不发 Authorization

`POST /api/llm/providers/:id/test` 与 `POST /api/llm/providers/:id/sync` 对
`auth: "none"` 的 provider SHALL 发出不带 `Authorization` 头的请求
（Ollama/LM Studio 的 `/v1/models` 无 key 即答）；对 `auth: "bearer"` 的
provider 保持既有行为（带 key）。其余探活/同步语义（5s 超时、latencyMs、
分类器、roster 合并纪律）逐条不变。

#### Scenario: keyless 探活成功

- **WHEN** 对 `auth: "none"` 的 Ollama provider 执行 test
- **THEN** 请求不带 Authorization 头，Ollama 的 `/v1/models` 200 →
  `{ ok: true, latencyMs }`

#### Scenario: keyless 同步合并模型

- **WHEN** 对 keyless 本地 provider 执行 sync
- **THEN** `/v1/models` 列出的 serving 模型并入 roster，分类器语义不变

### Requirement: 本地车道流入 fleet runner 子进程（可断言）

经 dsh profile 写入的用户 provider 路由（既有机制）SHALL 覆盖本地 provider——
即一个 `auth: "none"` 的本地 provider 在被设为默认（或被角色/部署引用）后，
fleet runner 拉起的子进程 dsh home SHALL 能解析到该 provider 的路由与模型。
该要求 SHALL 以可自动断言的方式落地（runner 种子 home 的路由文件包含该
provider 路由），而非仅文档说明。

#### Scenario: 舰队子进程解析本地路由

- **WHEN** 一个 `auth: "none"` 的本地 provider 被设为默认模型车道
- **THEN** runner 侧（共享 dsh profile/种子 home）的路由文件包含该 provider 的
  baseUrl 与模型清单，且凭据存储中该 provider 的条目为**空值**（路由可解析、
  无任何密钥材料）

#### Scenario: chat 车道与舰队车道同源

- **WHEN** 同一本地 provider 同时服务 chat 与 fleet 两面
- **THEN** 两面的路由来源是同一份 dsh profile 写入（单源），无第二份配置
