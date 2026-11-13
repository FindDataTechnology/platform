# add-local-model-lane — 本地模型车道产品化（隐私档的真正落点）

## Why

「本地运行 + 私密」是已拍板的产品承诺，而**推理**是唯一还没闭合的出网点：每条
对话、每个 agent 回合都要把内容发给云端模型。泄洪道其实存在——用户自定义
provider（任意 `baseUrl`，openai-completions 协议，流经 cell 与 fleet runner 共用的
dsh profile）——但它不是产品：① `createProvider` **强制要求 API key**
（`requireKey: true`），而 Ollama/LM Studio 根本没有 key，用户只能填假 key；
② 没有本地预设，用户必须自己知道 Ollama 的 URL 形态（`http://127.0.0.1:11434/v1`）
与协议选择；③ 模型发现/探活虽已存在（`sync` 走 `GET <baseUrl>/models`），但
keyless 场景下探活请求带着空 Authorization 的行为未定义；④ fleet runner 子进程
继承该车道**未经断言**。本 change 把「指向本机模型」从配置技巧升为一等车道。

## What Changes

- **keyless provider（新）**：provider 增 `auth: "bearer" | "none"`（缺省 bearer，既有
  记录视为 bearer）；`auth: "none"` 时 `apiKey` 非必填、探活/同步/推理请求不携带
  Authorization 头。Ollama（`http://127.0.0.1:11434/v1`）与 LM Studio
  (`http://127.0.0.1:1234/v1`) 走 none。
- **本地预设（新）**：provider 创建面提供「本地模型」预设（Ollama / LM Studio /
  自定义三者），选中即填 baseUrl/协议/auth 形态；Ollama 预设附一行可达性说明。
- **发现与探活适配（小）**：`test` 与 `sync` 对 `auth: "none"` 的 provider 不发
  Authorization 头（Ollama 的 `/v1/models` 无 key 即 200）；其余分类逻辑
  （serving/not_chat/…）不变。
- **fleet 继承断言（新）**：本地 provider 的路由经共享 dsh profile 流入 fleet
  runner 子进程——立一条验证要求（runner 的 dsh home 能解析到该 provider 的
  路由与凭据引用），把「聊天车道可用、舰队车道未知」变成已断言。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `llm-model-management`: provider 增 `auth` 形态（none/bearer，缺省 bearer 向后兼容）；
  预设（本地模型三形态）进创建面；探活/同步对 none 不带凭据；新增「本地车道流入
  fleet runner 子进程」的验证要求。

## Impact

- **代码**：`llm-providers.js`（auth 字段 + requireKey 条件化 + 探活/同步适配）、
  `server/routes/llm.js`（CRUD/test/sync 透传）、dsh 侧凭据引用（none 时
  `.credentials.yaml` 不写该 provider 的 key 条目）、`web/src`（创建面预设与 auth
  选择、i18n 五语言）。
- **契约**：既有 provider 记录零迁移（缺 auth 字段即 bearer）；`apiKey` 仍可为空
  字符串存储（现状允许），只是 `auth:"bearer"` 时探活/推理会带空 Bearer——文档
  化为不支持组合。
- **不改变**：reserved env 路由、sub2api 车道、默认模型指针语义、模型同步的
  分类器。
