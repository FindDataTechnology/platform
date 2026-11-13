# Tasks — surface-deployment-bindings

## 1. 实施

- [x] 1.1 `web/src/lib/packs-api.ts`：`DeployResult` 增可选 `deploymentBindings`
      （`granted[{agentId,bindingKey}]`／`failed[{agentId,bindingKey,code}]`／`revoked`），
      与平台响应同形，令牌值不在契约里
- [x] 1.2 `PackDetailDialog` 部署分支记录该报告并在部署按钮上方呈现三行；原因码分档
      （`no_account`／`empty_scope`／`connector_not_configured`／其他带码兜底），未就绪用警示色
      而非破坏色——部署本身是成功的
- [x] 1.3 五语种文案（zh-CN/en/es/fr/ja）严格同键；`check:locales` 通过
- [x] 1.4 `tsc --noEmit` 与 `web build` 全绿

## 2. 明确不做

- [ ] 2.1 不在部署前预演「将会有哪些绑定」：那是连接器状态面的职责，此处只回答本次部署的结局
