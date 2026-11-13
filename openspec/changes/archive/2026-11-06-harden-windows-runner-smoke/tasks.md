# Tasks: harden-windows-runner-smoke (paas)

## 1. Product fixes

- [x] 1.1 `dsh-profile-template/package.json`：补 `"version": "0.0.0"`（inventory identityFromManifest 要求非空 version）
- [x] 1.2 `agent-runner/manager.js` `sampleRssBytes`：win32 短路 return null（消灭每 poll ps 噪声）
- [x] 1.3 `.github/workflows/win-install-smoke.yml`：新增 Phase B+ runner 腿——打包环境起 agent-runner（AGENT_SERVING_REGISTRY_URL 指向 Phase B 的 server 本地 feed，LLM 键不注入）→ manifest body 装 minimal serving pack → `/api/wanxing/fleet/deployments` 部署 → 轮询 `/health` 直到 `children>=1` → 断言 dsh 子进程存活 ≥30s（抓 0xc0000142 类「子进程秒死」回归）

## 2. Verify & ship

- [x] 2.1 `node scripts/test-wanxing-facade.mjs` 等受影响套件全绿；`openspec validate harden-windows-runner-smoke --strict` 过
- [x] 2.2 显式路径提交；下一班 win-smoke 跑 Phase B+ 真证（workflow_dispatch）——✅ 2026-11-06 实弹：v1.3.28 出片（testaction001 池 42154182609 全绿）+ smoke 三班真证（42161353553 全绿：装包→部署→feed 领回→rhythm 自回合 spawn→resident 30s 存活→Phase C；三课实弹课并入本 change：B+ 并入 B 同步会话/rhythm 懒 spawn 首触/publish job checkout）
