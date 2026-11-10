# llm-model-management Specification

## Purpose
Operator management of LLM providers and their model rosters from the Settings Models page: REST CRUD under `/api/llm/`, a reachability test probe, per-provider sync that reconciles the roster against the provider's own gateway (including the reserved env-generated route, which is also runtime-overridable), editable model lists, a default-model pointer changed via `PUT /api/llm/default` without restarting dsh, API keys never returned to the client (only `hasKey`), and a read-only roster view for non-admin users.

## Requirements

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

### Requirement: Test endpoint probes provider reachability
`POST /api/llm/providers/:id/test` SHALL perform a lightweight probe of the provider's base URL. For OpenAI-compatible providers, the probe SHALL be a `GET <baseUrl>/models` with the API key in the `Authorization: Bearer` header. A 2xx response within 5 seconds counts as success; the response SHALL include `latencyMs`. On any non-2xx or timeout, the response SHALL include `ok: false` and a sanitized `error` string (the response body SHALL be truncated to 200 characters and SHALL NOT include the API key).

#### Scenario: successful probe
- **WHEN** the user clicks Test on a provider whose base URL is reachable
- **THEN** the endpoint SHALL return `{ ok: true, latencyMs: <number> }`
- **AND** the UI SHALL show a green check with the latency

#### Scenario: failed probe
- **WHEN** the user clicks Test on a provider whose base URL is unreachable
- **THEN** the endpoint SHALL return `{ ok: false, error: "..." }` with the error message
- **AND** the UI SHALL show a red cross with the error

### Requirement: API keys are never exposed
No endpoint SHALL return the configured API key. The `hasKey` boolean is the only signal exposed to the client. The UI for editing a provider SHALL show a placeholder ("API key (leave blank to keep current)") and SHALL submit the new key only when the field is non-empty; an empty field on edit means "keep the existing key". Logs SHALL NEVER include the API key value.

#### Scenario: apiKey is masked on read
- **WHEN** the client fetches the provider list
- **THEN** no provider record SHALL include the apiKey field
- **AND** `hasKey: true` SHALL be present when a key is configured
- **AND** `hasKey: false` SHALL be present when no key is configured

### Requirement: Models page lists providers with cards

The Models page SHALL render one card per provider, showing name, type, base URL (truncated), hasKey indicator (🔒 / 🔓), connection status (last test result with relative timestamp), and a list of discovered model ids. Each user-managed card SHALL have buttons: **Edit**, **Test**, **Delete** (with confirm). The reserved env-route card SHALL offer **Test**, the model-list editor, and a base-URL override action, and SHALL NOT offer **Delete** or API-key editing; it SHALL carry a persistent visual marker distinguishing it as the deployment's built-in lane. Above the card list, the page SHALL have an **Add provider** button and a **Set default** affordance that shows the current default model id and links to the per-card "Set as default" action.

#### Scenario: provider card shows connection status

- **WHEN** the page renders
- **THEN** each provider card SHALL show a green check or red cross for the last test
- **AND** SHALL show the relative time since the test

#### Scenario: add provider opens form

- **WHEN** the user clicks Add provider
- **THEN** a modal form SHALL open with fields: name, type, baseUrl, apiKey
- **AND** the Save button SHALL be disabled until all required fields are filled
- **WHEN** the user saves
- **THEN** the form SHALL POST to `/api/llm/providers`
- **AND** the page SHALL refetch and the new card SHALL appear

#### Scenario: delete with confirm

- **WHEN** the user clicks Delete on a user-managed provider card
- **THEN** a confirmation dialog SHALL appear
- **WHEN** the user confirms
- **THEN** the client SHALL call `DELETE /api/llm/providers/:id`
- **AND** the card SHALL disappear on success

#### Scenario: reserved card is editable but not deletable

- **WHEN** the page renders the reserved env-route card for an admin
- **THEN** the model-list editor and base-URL override SHALL be available
- **AND** no Delete action and no API-key field SHALL be presented
- **AND** the card SHALL indicate whether an override is active, with an action to clear it (restoring the image/env projection)

### Requirement: Default model pointer
The page SHALL display the current default model id (provider + model) and SHALL allow the user to change it via a per-card "Set as default" action. Changing the default SHALL call `PUT /api/llm/default` and SHALL NOT restart dsh. The change SHALL be reflected in the sidebar's current-model indicator after the next WS `model_changed` event.

#### Scenario: change default
- **WHEN** the user clicks "Set as default" on a model within a provider card
- **THEN** the client SHALL call `PUT /api/llm/default` with the chosen provider+model id
- **AND** the page SHALL show the new default highlighted
- **AND** the sidebar model indicator SHALL update after the WS `model_changed` event

### Requirement: Provider model sync reconciles every provider including the reserved route

The server SHALL expose `POST /api/llm/providers/:id/sync` (admin-gated) which reconciles a provider's model roster against the provider's own gateway. Sync SHALL: fetch the full id list from `GET <baseUrl>/models`, then probe each id with a single minimal chat completion (bounded concurrency, per-probe timeout), classify each id as exactly one of `serving`, `unauthorized`, `upstream_down`, `rate_limited`, `not_chat`, or `error`, merge `serving` ids into the provider's model roster, and persist the full per-id status map on the provider record. Sync SHALL NOT delete existing roster entries whose probe did not serve. The response SHALL include the classification summary; probe error strings SHALL be sanitized (no API key, bounded length) before persistence or return.

Sync SHALL apply identically to the reserved env-generated route: serving ids merge into that route's persisted override roster (see "Reserved env route is runtime-overridable"), and its status map persists, so the built-in lane reconciles against gateway drift through the same operator action. A sync SHALL NOT write the route's API key or delete the route.

#### Scenario: sync classifies and merges

- **WHEN** an admin triggers sync on a provider whose gateway lists serving, unauthorized, and upstream-down ids
- **THEN** the server SHALL return a per-id status map covering every listed id
- **AND** the provider's model roster SHALL contain every id classified `serving` that was not already present, appended with family-table default metadata
- **AND** a subsequent `GET /api/llm/providers` SHALL expose the status map and roster

#### Scenario: sync never evicts on a bad probe

- **WHEN** an id already in the provider's roster is classified other than `serving`
- **THEN** the roster entry SHALL remain, and the status map SHALL flag it
- **AND** the Models page SHALL render it with a non-selectable-status indication distinct from serving entries

#### Scenario: classifier-shaped id

- **WHEN** a probed id answers HTTP 200 with empty/whitespace content
- **THEN** the id SHALL be classified `not_chat` and SHALL NOT be merged into the roster

#### Scenario: concurrent sync rejected

- **WHEN** a sync is already running for any provider and another mutation or sync arrives
- **THEN** the server SHALL respond HTTP 409 with the busy error, and the running sync SHALL be unaffected

#### Scenario: sync persists on the reserved env route

- **WHEN** an admin triggers sync on the reserved env-generated provider route
- **THEN** the server SHALL classify every listed id and persist `serving` ids into the route's override roster with the per-id status map
- **AND** the change SHALL reach connected clients via the models broadcast without a restart
- **AND** the route's API key and existence SHALL be untouched

#### Scenario: metadata comes from the local family table

- **WHEN** a `serving` id is merged whose family is known to the local metadata table
- **THEN** the merged entry SHALL carry the table's contextWindow/maxTokens/reasoningEfforts
- **AND** an unknown family SHALL get conservative defaults (128k context, 8192 maxTokens, no reasoning efforts)
- **AND** sync SHALL NOT alter metadata fields of entries already present in the roster

### Requirement: Reserved env route is runtime-overridable

The env-generated provider route SHALL support a persisted operator override covering its model roster and base URL. Resolution precedence SHALL be: override value > environment variable > image-built-in default. The override SHALL persist across restarts in the deployment's data dir, SHALL be admin-gated to mutate, and SHALL apply through the existing hot-reload path (no dsh restart, no image rebuild). The route's API key SHALL come exclusively from the environment: no endpoint SHALL accept or persist a key for the reserved route. Clearing the override SHALL restore the environment/built-in projection and is the rollback path.

#### Scenario: override wins over the baked roster

- **WHEN** an override roster exists for the reserved route
- **THEN** the effective roster SHALL be exactly the override's entries
- **AND** the built-in roster SHALL have no effect until the override is cleared

#### Scenario: base-URL override redirects the lane

- **WHEN** the override sets a base URL differing from the environment's
- **THEN** the route's requests and sync probes SHALL target the override URL
- **AND** `GET /api/llm/providers` SHALL surface the effective URL with an override indicator

#### Scenario: clearing the override rolls back

- **WHEN** an admin clears the override
- **THEN** the route SHALL fall back to the environment/built-in roster and URL
- **AND** connected clients SHALL receive the refreshed model list without a restart

#### Scenario: key mutations on the reserved route are refused

- **WHEN** a mutation attempts to set or change the reserved route's API key or delete the route
- **THEN** the server SHALL reject it with an error naming the reserved semantics
- **AND** no stored state SHALL change

### Requirement: Provider model list is editable at runtime

`PUT /api/llm/providers/:id` SHALL accept a `models` array replacing the provider's roster: entries carry `id` plus optional `name`/`contextWindow`/`maxTokens` (absent fields fall back to the family table, then conservative defaults). The mutation SHALL validate ids are unique non-empty strings, run through the same write lock + hot-reload path as other provider edits, and take effect without a restart or image rebuild. This SHALL apply to the reserved env-generated route through its override roster. The Models page SHALL expose a per-provider model-list editor (add id, remove entry, set default pointer, edit each entry's `contextWindow` and `maxTokens`) restricted to admin users.

#### Scenario: operator adds a model without a rebuild

- **WHEN** an admin PUTs a provider record whose `models` array contains a new id
- **THEN** the stored roster SHALL include it with family-table or provided metadata
- **AND** the models WS broadcast SHALL refresh connected clients' pickers without a dsh restart
- **AND** no image build, config-map change, or pod intervention SHALL be required

#### Scenario: operator edits the reserved route's roster without a rebuild

- **WHEN** an admin PUTs the reserved env-generated route with a `models` array
- **THEN** the override roster SHALL replace the previous override (the image's built-in roster remains the fallback once the override is cleared)
- **AND** the effective roster SHALL refresh via the hot-reload path with no restart

#### Scenario: invalid models payload rejected

- **WHEN** the `models` payload has duplicate ids, empty ids, or a non-array
- **THEN** the server SHALL respond HTTP 400 and leave the stored roster unchanged

#### Scenario: per-entry token limits are editable

- **WHEN** an admin sets an entry's `contextWindow` or `maxTokens` in the model-list editor and saves
- **THEN** the stored entry SHALL carry the provided values, validated as positive integers
- **AND** entries with omitted fields SHALL keep family-table or conservative-default values

### Requirement: Non-admin users see a read-only model roster
The Models settings section SHALL present non-admin users a read-only view of the models currently available to them — the providers' model rosters with serving status where known — and SHALL NOT render provider management controls (add, edit, delete, test, sync) for those users. Users with the admin role, and any user of an open-access deployment where admin gating is disabled, SHALL continue to see the full provider management surface unchanged. The read-only view SHALL carry no secrets: provider base URLs and API-key presence indicators SHALL follow the same masking rules as the management view.

#### Scenario: non-admin gets the roster without controls
- **WHEN** a signed-in non-admin user opens Settings → Models
- **THEN** the section SHALL list the available models with their provider and serving status where known
- **AND** no add/edit/delete/test/sync control SHALL render

#### Scenario: admin keeps the full management surface
- **WHEN** an admin user opens Settings → Models on the same deployment
- **THEN** the section SHALL render the full provider management surface exactly as before

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
provider 路由），而非仅文档说明。**本要求的覆盖面是 dsh harness 的部署**
（runner 种子 home 即 dsh profile 的消费方）；ACP harness 的部署沿用其自身
的凭据解析（`compose-acp`），不在本要求范围内——若未来 ACP 部署需要本地
车道，按同一「路由可解析、无密钥材料」的口径另立断言。

#### Scenario: 舰队子进程解析本地路由

- **WHEN** 一个 `auth: "none"` 的本地 provider 被设为默认模型车道
- **THEN** runner 侧（共享 dsh profile/种子 home）的路由文件包含该 provider 的
  baseUrl 与模型清单，且凭据存储中该 provider 的条目为**空值**（路由可解析、
  无任何密钥材料）

#### Scenario: chat 车道与舰队车道同源

- **WHEN** 同一本地 provider 同时服务 chat 与 fleet 两面
- **THEN** 两面的路由来源是同一份 dsh profile 写入（单源），无第二份配置
