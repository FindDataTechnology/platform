# add-device-pairing-auth — Tasks

## 1. 绑定存储泛化（mp-bindings）

- [x] 1.1 扩展 `gateway/mp-bindings.js` 值形状：`app:<deviceId>` namespace 条目携带 `pubkey`（base64url 裸 32 字节）与 `label`（封顶 64）；单测覆盖：老格式加载（openid 条目无新字段）、新格式持久化往返、openid 与 app 条目同文件共存互不干扰
- [x] 1.2 落跨栈签名固定向量：App 侧 `@noble/ed25519` 生成的公钥/签名（消息 `deviceId:nonce`），node:crypto 经 JWK 包装验签通过；向量进测试夹具并单测锁定（两端一致性的契约锚）

## 2. app-auth 共享模块

- [x] 2.1 新建 `gateway/app-auth.js`：pair（消费绑定码→写绑定→签发含 `kind:"app"`/`did` 的 JWT）、challenge（每设备单槽、TTL 60s、单次消费、全局上限+惰性清扫）、login（Ed25519 验签→换发）、devices 列表（不回传公钥）、revoke；单测覆盖 400/401 分支、码过期/复用、nonce 重放、未知 deviceId
- [x] 2.2 单测：撤销后的 login 401 与从未绑定的 401 响应形状一致（不泄漏绑定史）；跨账户列表/撤销隔离（A 不可见不可撤 B 的设备）

## 3. 双部署形状接线

- [x] 3.1 `gateway/index.js` 在 `/api/mp/*` 块旁挂载五个 `/api/app/*` 端点；单进程新增 `server/routes/app.js` 孪生 import 同一 `app-auth.js`；两形状各过一遍路由级冒烟（pair→challenge→login 全链 curl）
- [x] 3.2 `GET /api/config` 增加 `capabilities.devicePairing`（取值 `Boolean(MP_TOKEN_SECRET)`），单测覆盖有/无 secret 两态与老部署无 `capabilities` 字段的宽容读取

## 4. web 设置页 devices 节

- [x] 4.1 Settings 模态十节化：slug `devices` 排 `wechat-app` 后；铸码卡（数字码+倒计时+QR，URL `<web-origin>/settings/devices?bindcode=<code>`，复用现有 qrcode 依赖与微信小程序节交互骨架）；组件级验证节可达、码可刷
- [x] 4.2 设备列表（label+boundAt）与单设备撤销（确认弹层）；i18n 键补齐六语言；验证列表实时反映 pair/revoke
- [x] 4.3 Playwright e2e（走 CI）：devices 节深链 `/settings/devices`、铸码出码出 QR、列表展示、撤销后设备消失——四断言绿

## 5. 回归与验收

- [x] 5.1 小程序路径零回归：`mp-auth`/`mp-bindings` 全量单测绿 + 既有 MP 登录 e2e 绿（共享文件改动的硬边界）
- [x] 5.2 全链真配对冒烟（脚本留档 docs/ 或 scripts/）：真 web 会话铸码 → curl 模拟 App（@noble 签名）pair 拿 JWT → challenge→login 静默换发 → 再 login（nonce 重放）401 → web 撤销 → 该设备 login 401；七步全过
- [x] 5.3 `openspec validate add-device-pairing-auth --strict` 通过 + 全仓 lint/typecheck/单测绿（既有基线不倒退）
