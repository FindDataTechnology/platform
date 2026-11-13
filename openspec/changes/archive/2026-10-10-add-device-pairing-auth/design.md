# add-device-pairing-auth — Design

## Context

miniprogram-auth 已建成一条"绑定码→账户绑定→平台 JWT"的身份路径，双部署形状（gateway per-user cells / 单进程 `server/routes/mp.js`）共享同一组模块（`gateway/mp-auth.js`、`gateway/mp-bindings.js`，注释明言"shared verbatim by both entrypoints"）。本设计在这组模块旁边长出第三种客户端（通用客户端 App）的同构路径：ADR-0020 定案为绑定码泛化 + Ed25519 设备密钥，不走 OIDC。绑定码铸造机制（6 位、5 分钟、单次、web 会话担保）与 JWT 工具（`signMpJwt`、HS256、`MP_TOKEN_SECRET`）全部复用。

## Goals / Non-Goals

**Goals:**

- `/api/app/*` 五个端点在两种部署形状上行为一致，App 只需实现一份客户端逻辑
- 设备绑定与 openid 绑定共存于同一持久化文件且互不干扰，老格式（openid 条目）读写完全兼容
- 撤销能力与设备列表随第一版上线（无撤销的设备凭证不发布）

**Non-Goals:**

- App 客户端本体、多工作区、离线推送（`add-mobile-app` 及后续）
- `MP_TOKEN_SECRET` 轮换、token 吊销清单（JWT 过期 + 绑定撤销已覆盖本场景）
- 管理员代管他人设备（列表与撤销仅限本人账户）

## Decisions

### D1: 泛化 mp-bindings 存储，而非另起文件

绑定文件 key 以 `app:<deviceId>` 前缀分 namespace；value 在 `{email, groups, boundAt}` 之上增加 `pubkey`（base64url 裸 32 字节 Ed25519 公钥）与 `label`（设备自报名，长度封顶、仅展示用）。openid 条目格式不变。**替代方案**（独立 app-bindings.json）被否：一个身份子系统一份运维心智；文件级原子写（temp+rename）约定已在这套代码里。

**回滚相容性**：老代码的加载器按 `typeof value.email === "string"` 过滤并保留条目，`app:` key 会被读入且随 persist 存活——但 `pubkey`/`label` 字段会被老代码的塑形剥掉。后果：回滚后再前进，已配对设备需重新配对（App 尚未发布，无在野用户，可接受）；小程序路径全程无感。

### D2: 密码学形状——Ed25519 裸钥 + JWK 包装，签名消息定为 `deviceId:nonce`

- 公钥传输格式：base64url 裸 32 字节（App 侧 `@noble/ed25519` 的原生输出）；服务端用 node:crypto 经 JWK（`{kty:"OKP", crv:"Ed25519", x}`）包成 KeyObject 验签，零新依赖
- 签名消息：UTF-8 的 `deviceId + ":" + nonce`——两端各自拼串、无需结构化序列化共识
- 单测放一组**跨栈固定测试向量**（@noble 生成的签名，node 验证通过），锁死两端一致性

**替代**（对称 secret + HMAC）被否（ADR-0020：绑定文件泄露即冒充）；**替代**（SPKI DER 传输）被否：App 侧多一步封装，裸 base64url 两端都最短。

### D3: 挑战 nonce——内存存储，每设备单槽

挑战沿用 bindCodes 的内存 Map 惯例：TTL 60 秒、单次消费、**每 deviceId 同时至多一个在途 nonce**（新挑战顶掉旧挑战）、全局上限 + 惰性清扫封内存。网关重启在途挑战作废，客户端重试即可，无需持久化。**替代**（持久化 nonce）被否：换不来可观测收益。

### D4: 绑定码铸造——一个池子，一扇门

web 设置页 devices 节直接调用既有 `GET /api/mp/bindcode`（`accept: application/json`）铸造：同一账户、同一生命周期、同一单次消费语义，不新增别名端点。同一池的码理论上小程序也能消费（反之亦然）——特性而非缺陷：码只担保账户所有权。QR 载荷沿用微信小程序节的 URL 约定 `<web-origin>/settings/devices?bindcode=<code>`，App 一次扫描同时取到实例地址与码。

### D5: JWT claims——只加不改

`signMpJwt` 原样复用；App token 的 payload 增 `kind:"app"` 与 `did:<deviceId>`。MP token 不动（不加 `kind`，缺省即 mp）——小程序行为零变化是本 change 的硬边界。下游（cell 路由、权限组）只看 email/groups，不感知新字段。

### D6: 模块落位与双形状接线

- 新 `gateway/app-auth.js`：配对消费、挑战发放、验签换发、设备列表/撤销的纯逻辑（拿到 bindings 引用与铸码/签发回调）
- `gateway/index.js` 在 `/api/mp/*` 路由块旁挂 `/api/app/*`；单进程新增 `server/routes/app.js` 孪生，同样 import `gateway/app-auth.js`（延续 mp-auth 的共享模式）
- `GET /api/config` 的 `capabilities` 对象：`devicePairing` 的取值 = `Boolean(MP_TOKEN_SECRET)`——与 MP 路径同一开关，不引入新环境变量

### D7: web 设置页 devices 节

slug `devices`、排在 `wechat-app` 之后（settings-surface delta 已改十节）；组件复用微信小程序节的"铸造 + 倒计时 + QR"交互骨架，QR 用 web 已有 `qrcode` 依赖；列表条目 = label + boundAt + 撤销按钮（撤销需确认弹层）。i18n 键 ×6 语言。

## Risks / Trade-offs

- [mp-bindings 共享文件被双路径读写，泛化引入回归] → 老格式加载单测（openid 条目无 pubkey 字段）+ 小程序登录 e2e 回归列入验收
- [challenge 端点未认证，可被刷] → 每设备单槽 + TTL 60s + 全局封顶 + 惰性清扫；内存上界有界，暴力枚举 deviceId 在 Ed25519 验签前就被无绑定短路
- [两端跨栈签名不一致（@noble vs node:crypto）] → D2 的固定向量单测锁死；消息格式刻意取最简拼接
- [回滚后再前进丢 pubkey（D1）] → App 未发布无在野设备，重配对即可；部署记录标注此已知行为
- [deviceLabel 是自报文本] → 长度封顶（64）、展示前转义、不参与任何鉴权判断

## Migration Plan

纯增量：无数据迁移、无环境变量新增、老客户端零感知。部署 = 正常发布循环（gateway + 单进程同滚）；回滚 = revert 镜像（D1 已注回滚语义）。上线后用真配对冒烟：web 铸码 → curl 模拟 App 配对 → 挑战换发 → 撤销 → 401 复验。
