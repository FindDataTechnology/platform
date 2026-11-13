# Tasks: add-local-model-lane

## 1. keyless provider（服务端）

- [ ] 1.1 `llm-providers.js`：provider 记录增 `auth`（"bearer"|"none"，缺省 bearer）；`validateInput` 的 `requireKey` 改为按 auth 判定（none 时 key 可空）；既有记录读取缺字段视为 bearer（零迁移）
- [ ] 1.2 `credentialRefsForUserProviders`：auth=none 的 provider **不产出**凭据条目（`.credentials.yaml` 无该 key 记录）；单测断言
- [ ] 1.3 探活/同步适配：`test` 与 `sync` 对 auth=none 不发 Authorization 头；bearer 行为逐字节不变；单测拦截 fetch 断言请求头
- [ ] 1.4 CRUD 透传：create/update/GET 暴露 auth；非法值拒（非 bearer/none → 400）

## 2. 舰队继承断言（D3 落地）

- [ ] 2.1 单测：设一个 auth=none 的本地 provider 为默认 → `writeLlmProfile` 后，断言 runner 种子侧（共享 dsh home 的路由文件）包含该 provider 的 baseUrl 与模型清单，且凭据存储无该 provider 条目
- [ ] 2.2 若断言暴露 runner 侧任何缺口（路由缺失/凭据误写），当场修到绿并把缺口记入 design 补记

## 3. 创建面预设（web）

- [ ] 3.1 provider 创建面加「本地模型」预设（Ollama/LM Studio/自定义）：选中预填 baseUrl/auth/协议，说明行「确认本机推理服务在运行」；auth 选择器暴露（预设填充后可改）；预设不自动建记录
- [ ] 3.2 i18n 五语言同批（locale 闸）
- [ ] 3.3 e2e（fast，mock fetch）：选 Ollama 预设 → 提交 → Models 页卡片可见、auth=none 展示正确

## 4. 见证

- [ ] 4.1 `npm test` 全绿 + `openspec validate add-local-model-lane --strict` 绿
- [ ] 4.2 真机手动：本机 Ollama（或 LM Studio）起一模型 → 建卡 → 设默认 → chat 一轮 + fleet 部署一岗跑一轮，两面眼见截台账；模型家族元数据若有误伤按家族表补行流程走
