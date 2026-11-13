## Why

壹座 pack 详情的「部署为服务」表单目前只让部署者配两样东西：每个 serving agent 的节奏覆盖和部署键粘贴。但部署 API（`POST /api/packs/:id/versions/:version/deploy`）早已接受 `models`（每 agent 初始模型，gateway/packs.js:1242 起）和 `budgets`（每 agent 回合预算分钟数，gateway/packs.js:1134 起），并带全三道模型准入闸（manifest 白名单 ∩ 部署键车道 ∩ runner roster）。萬星控制台的部署向导（fd-wanxing DeployWizard）已经把这两个字段暴露给部署者，壹座这边却只能「先部署、再跳萬星控制台改服务配置」——同一个动作被拆成三步，而且刚部署完的窗口里跑的是 runner 默认模型/预算，不是部署者想要的。

这是纯前端接线缺口：后端契约完整（a2a-agent-serving spec 已规定 deploy-time model/budget 的语义与校验），壹座表单和 `deployPack()` 包装没跟上。

## What Changes

- 壹座 pack 详情部署区为每个 serving agent 增加两个输入：**模型**（文本输入 + 声明白名单 datalist 自动补全 + 声明默认值 placeholder）、**回合预算分钟数**（数字输入，客户端按平台规则校验：正整数 ≤120）。
- `web/src/lib/packs-api.ts` 的 `deployPack()` 增加可选 `models` / `budgets` 参数，非空才上请求体（与 rhythms 的既有纪律一致：absent = 声明/默认语义，不用 null——部署时无既有配置可清）。
- `PackManifestAgent.serving` TS 类型补 `model` / `modelWhitelist` / `budget` 字段（manifest 里已存在的字段，类型层从未跟上）。
- 部署失败的服务端模型闸错误（`MODEL_LANE_REJECTED` 等）在表单里本地化呈现，不裸英文。
- i18n 五语言（en/zh-CN/es/fr/ja）补 key；`check:locales` 保持绿。

**不动**：萬星控制台的服务配置面板（部署后编辑面，已是完整实现）；harness 选择（部署 API 支持但萬星向导也未暴露，保持一致不扩面）；`agents` 子集选择、notifyChannel 等其余部署体字段。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `pack-marketplace`: 部署区表单从「部署键 + 节奏」扩为「部署键 + 节奏 + 模型 + 预算」，部署请求携带部署时的模型/预算选择；空输入 = 该维度不动（既有覆盖 → 声明 → 平台默认，见 design D1）。

## References

- 后端契约（已存在、本变更不改）：`openspec/specs/a2a-agent-serving/spec.md`「Deploy action composes registry-native assets」——deploy-time model/budget 落为部署初始服务配置，模型走与事后配置写同款车道校验。
- 生效值优先级与来源徽标：`openspec/specs/agent-service-config/spec.md`。
- 先例 UI（萬星向导，字段形态的参照）：fd-wanxing `wanxing-web/src/views/console/DeployWizard.jsx`。
- 预算规则单一来源：`lib/pack-manifest.js` `budgetMinutesError`（正整数 ≤ `BUDGET_MAX_MINUTES`=120）。
