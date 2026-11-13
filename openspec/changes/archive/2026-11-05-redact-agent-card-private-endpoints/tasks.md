# Tasks: redact-agent-card-private-endpoints (paas)

## 1. Twin redaction patch

- [x] 1.1 `gateway/wanxing/a2a.js`：`publicCard()` provider 行经红敏器（与 fd-wanxing 同判定：私网/CGNAT/loopback/link-local/单标号/集群后缀/不可解析剔 `url`）
- [x] 1.2 `scripts/test-wanxing-facade.mjs`（paas 版）补三态卡面测试

## 2. Verify & ship

- [x] 2.1 `node scripts/test-wanxing-facade.mjs` 全绿；`openspec validate redact-agent-card-private-endpoints --strict` 过
- [x] 2.2 显式路径提交推送；platform 镜像出片（走既有快照/发布链）
- [x] 2.3 GitOps 滚 platform 新 tag；从 windows-admin 复验 platform 域名卡片
