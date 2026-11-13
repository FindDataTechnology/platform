# Design — add-facet-publish-bridge（F3.2）

## D1 服务面：配对门开到 facet（模块复用，零新依赖）

facet/index.js 挂新模块 `facet/pairing.js`，内部全用现成件：

- `createMpBindings({ file: DATA_ROOT/bindings.json })`——纯 JSON 文件存储（项目文件
  持久化惯例），facet 自持一份；openid 键与 `app:` 键同一池不同前缀，facet 这份只会有
  `app:` 键。
- `createAppAuth({ tokenSecret: MP_TOKEN_SECRET, ttlHours, bindings })`——`app-auth.js`
  逐字复用（第三次复用出场：网关、单进程、facet）。未配置 secret 时 pair/challenge/
  login 答 503（与网关同一道闸），facet 壳不受影响。
- 路由：`GET /api/mp/bindcode`（facet 会话铸码；HTML 页文案面向 CLI 配对，非小程序）、
  `POST /api/app/pair|challenge|login`、`GET /api/app/devices`、
  `DELETE /api/app/bind/:deviceId`（设备管理面吃 resolveUser 身份——app token 亦可）。
- 身份第三通道：组合器 `withAppBearer(baseResolve, appAuth)`——先走原两通道（代理→
  会话），再试 Bearer 的 `accountFromToken`（仅 `kind=app`）。组合器放 pairing.js，
  index.js 一行接线；测试可直接对组合器断言（不想测 Logto）。

绑定码即账号断言：码上带铸造时的 groups，`pair` 铸出的 token 携 `creators` ⇒ 官方侧
`isCreator` 直接过门——发布门的组判定零改动。

## D2 CLI：publish = 搬运体，不自设鉴权

```
facet publish <manifest.json | packRef> [--from <base>] [--pack-id <官方id>] [--new]
              [--market <url>] [--no-open]
```

- **载荷来源**：位置参数是磁盘上存在的文件路径 ⇒ 本地清单（facet-pack-builder 产物
  形状）；否则视为 packRef——`--from` 显式给源基址，或 packRef 本身是 URL 时取其
  origin。拉取走源实例**公开** detail（`GET {from}/api/packs/{id}`→`detail.manifest`，
  含 skills content——存储 manifest 原样）；私有/下架包在源上不可见即 404，如实报。
- **认证**：`~/.facet/publish-identity.json`（0600）存 `{deviceId, email, market}`；
  Ed25519 私钥存 `~/.facet/publish-key.json`（0600，PEM）。每次运行先静默续登
  （challenge→签 `deviceId:nonce`→login，两往返，token 永不落盘）；challenge 答
  `binding_required`（未配对/被吊销）落配对流：打印+打开 `{market}/api/mp/bindcode`，
  stdin 读 6 位码，pair 后继续。换 market 域时身份文件按域分别记。
- **推送**：`POST {market}/api/packs`，Bearer，体 `{packId, manifest}`。400 逐条透传
  `errors[]`；403=creators 门（提示配对账号需在创作者组）；404/forbidden=官方包不存在
  或非本人包。
- **id 映射**：`~/.facet/publish-map.json` 记 源包 id→官方 id。首发（无 --pack-id）成功
  后写入；续推自动沿用；映射失手（官方包已删）时报错并提示 `--new` 或 `--pack-id`，
  绝不静默双发。`--new` 恒走新包。
- node:crypto 全覆盖（generateKeyPairSync ed25519、JWK `.x` 出 base64url 裸 32B 公钥、
  `sign(null, data, priv)`），零新依赖。

## D3 测试形状

- `scripts/test-facet-publish-bridge.mjs`：express 上挂**真** pairing 模块+真
  registerPackRoutes+临时 packs.db，测试用自己的 resolveUser 桩替 Logto——驱动全链：
  铸码（桩会话）→pair（真 Ed25519）→静默登录→Bearer 发布→包落库且作者=码上账号；
  非 creators 组 403；未配 secret 的 facet 形状答 503。
- `scripts/test-facet-cli-publish.mjs`：stub 市场=同一套真模块（只缺 Logto），CLI 子进程
  （隔离 FACET_HOME）跑三态：本地清单发布成功、--from 跨实例拉推、403 门语透传；stdin
  喂 6 位码完成配对。

## D4 明确不做

- CLI 不做清单"预校验"放行（服务端是唯一校验权威；CLI 只做 JSON 可解析性检查）。
- 不给 facet 壳加设备管理 UI（管理面 API 就位，UI 挂账）。
- 私有包跨实例拉取（源上不可见=如实 404；要搬先转公开或用本地清单文件）。
