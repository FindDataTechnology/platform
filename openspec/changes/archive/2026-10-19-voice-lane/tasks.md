# voice-lane — 任务

## 1. 服务端

- [x] 1.1 `server/routes/voice.js`：`registerVoiceRoutes(ctx)`——transcriptions/speech 转发、key 三级解析、401 stale+connect、5xx 脱敏、25MB 413、`GET /api/voice/status`；`app.js` 注册；`GET /api/config` 附 `voice`。
  验证：`node --test scripts/test-voice-lane.mjs` 全绿（设计 D7 ①-⑨）
- [x] 1.2 `PUT /api/config/voice`（admin 门 + 校验 + 部分合并）；voice 配置解析（存储>env>默认，坏 JSON 降级）独立可测。
  验证：同上 ⑥⑦

## 2. 客户端

- [x] 2.1 `packages/core/src/api/extensions-api.ts`：`fetchVoiceStatus / transcribeVoice / synthesizeSpeech / updateVoiceConfig` + 类型。
  验证：typecheck 绿
- [x] 2.2 Composer：麦克风（MediaRecorder webm/mp4 回落）、`composer-audio-input`（`+` 菜单「语音转文字」）、状态机与 chip、转写插入不发送、不可用不渲染、connect 错误指引。
  验证：e2e `voice.spec.js`
- [x] 2.3 AssistantTurn：`turn-speak` 三态、单播放器、4000 截断提示、失败 toast + connect。
  验证：e2e `voice.spec.js`
- [x] 2.4 ModelsPage VoiceCard（admin 编辑/非 admin 只读、status 展示、PUT 保存）。
  验证：e2e 或组件级断言 + typecheck
- [x] 2.5 i18n 五语言（composer.voice* / turn.speak* / voiceCard.*）。
  验证：`npm run web:build` 绿 + 抽查 zh-CN/en 键

## 3. 测试门

- [x] 3.1 `scripts/test-voice-lane.mjs`（假音频服务 + 真 express 路由，覆盖 D7 ①-⑨）。
- [x] 3.2 `e2e/ciyuan-stub.js` 挂 `/v1/audio/*`（含真 mp3 fixture）；`e2e/voice.spec.js` 四场景；`playwright.config.js` 假媒体设备 + autoplay flag。
  验证：`npm run web:build:e2e` 后 `npx playwright test e2e/voice.spec.js` 绿
- [x] 3.3 全量回归：`node --test scripts/test-*.mjs` + `npm run typecheck` + playwright 全套。

## 4. 发布与真机

- [x] 4.1 提交只 `git add` 本变更文件（勿 `-A`），双推。
- [x] 4.2 `fd-build-channel` → 公开快照线（修剪 .github/workflows 只剩 image.yml；命令链只 `&&` + 双哨兵）→ run 绿 → relay → ccr digest → 双清单 → ArgoCD → rollout 绿 → pod imageID 全等。
- [ ] 4.3 真机 `scripts/verify-live-voice.mjs`：绑定 trial → 上传真 wav 转写非空 + 朗读 200 audio/mpeg + 词元 usage_logs 出现该 key 的 audio 车道用量行（计费主体=用户）。
- [x] 4.4 台账 §12.19 + 归档 + 主 spec `voice-lane` 同步（`openspec validate --specs`）。

## 实施记录（apply 阶段，2026-10-19）

- 2.1 的客户端 API 落在 `web/src/lib/voice.ts`（非 `extensions-api.ts`）：core 的 http 传输只暴露 `json()`，TTS 要二进制 Blob、ASR 要 FormData、录音要 MediaRecorder——都是浏览器专属，不进小程序兼容层。状态缓存 `web/src/hooks/useVoice.ts`（页面级单例，boot config `voice.enabled=false` 时零请求）。
- 服务端单测 `scripts/test-voice-lane.mjs` 14/14（D7 ①-⑨ 全覆盖 + speech 三用例 + unreachable）；**apply 中抓出一缺口**：`resolveVoiceKey` 在 email 为空时跳过查找，而 `ownerKey(null)` 映射到机器主人键（auth 关闭的本地单进程绑定存在那里）——已改为无条件 `liveToken(email)`。
- e2e `e2e/voice.spec.js` 9/9（状态/入口、音频文件转写插入且零附件、假麦克风录音转写、绑定 key 上行 + 401 标 stale + connect CTA 深链、朗读播放/停止、VoiceCard 改音色下一次合成携带、502 toast、停用全隐藏）；`playwright.config.js` fast 项目加 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required`；stub 内嵌 693B 真 mp3（ffmpeg sine），fixture `e2e/fixtures/voice-tiny.wav`（0.6s 静音，仅供 e2e 走通路径）。
- 全量门：`npm run test:unit` 1599/1599；fast e2e 全套 475 过 / 13 红 → 隔离重跑 10 个纯 flaky（全过）、`intent-onboarding:244` 是 role-nav-apps 第七处列表断言（已同步）、`composer-stop.spec` 为 main 固有竞态 flake（HEAD 基线 worktree 对照 7 轮各 5/6 红，`:63` 单跑 5/5 过）。
- 4.2 实证：快照 `6be8400` → run 39161136227 绿 → relay 04:06:40 → ccr digest `29d08729` → infra `955aea7` → 双 rollout 绿，双 pod imageID 全等。
- **4.3 部分完成（故不勾）**：`scripts/verify-live-voice.mjs` **ASR 全链 13 项 PASS**（用户 key 上行、转写插入、零附件、usage `audio:stt` 计到用户 key、断开回落）；**TTS 4 项 FAIL = 词元上游阻塞非壹座缺陷**——豆包握手 `403 requested resource not granted`（`volc.seedtts.default`）+ 腾讯 TTS 亦败（车道 503 无可用账号）。壹座侧按规格诚实 502。上游恢复后复跑该脚本应 ALL PASS。详见台账 §12.19。
