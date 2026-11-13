# 供方上牌通道（vendor-onboarding lane）· fork 适配档（§15.69 挂账 1）

## 目的

为 vendor 供方上牌闸提供 **server 侧受控注册/启停通道**，取代当前的生产凭证通道（console cookie+CSRF，registry-bounce 台账 §6 鉴权矩阵：`POST /api/servers/register|toggle` 需控制台会话 cookie + X-CSRF-Token）。

之所以现在必须补丁：旧通道的本质是把「控制台管理员会话」当机器凭据用——会话过期=全 lane 401（台账 §6 头号误报源同类）；供方 lane 要上 self-serve 火量, 不能用管理员会话背书。

## 通道形状（与 fd 线先例同轨）

- **排骨提交**: registry fork 新端点 `POST /api/vendor-servers/register` + `POST /api/vendor-servers/toggle`；
  鉴权=`srf_` 前缀服务令牌（与 surface-report 同一花样：entry bound + scope=onboarding），
  令牌发行仍经组控的运营面——供应方永远不经手任何 registry 写凭据（add-vendor-supply-open design D2 纪律）。
- **请求字段**: `{name, path, proxy_pass_url, description?, tags?, metadata{surface, vendor}}`；
  toggle 载荷 `{path, new_state}`（与现有 register+toggle 语义逐字节）。
- **rewire**: `gateway/vendor-onboarding.js` 的 `defaultWriter` env 开关：
  `REGISTRY_VENDOR_LANE=service-token` 时改走 service-token 端点（`MARKET_REGISTRY_URL`+`VENDOR_LANE_TOKEN`），
  其余情况维持 cookie+CSRF 兜底。切 lane 不改任何 pipeline（audit/statuses 不变）。
- **台账登记**：patch 落 fd 线谱系账本与 §6 鉴权矩阵条目（新增端点进列）。

## 部署窗口

- **推 fork 分支**：fd-vendor-lane-* 到 FindDataTechnology/mcp-gateway-registry → GHA image workflow（fd-* 规则）→ hkccr → cheap-3 relay → ccr，部署以「up -d --no-deps 指定 service」走标准线（§6 换版配方）。
- **切换顺序**：① patch 上线 → ② cheap-8 的台账 cycle: 生产窗 bulk 发行 `VENDOR_LANE_TOKEN`（srf_-前缀、scope=onboarding）→ ③ paas gateway/facet 改 env `REGISTRY_VENDOR_LANE=service-token` + 密钥注入（wanxing-fleet/registry_token 同伴域）→ ④ cookie+CSRF 兜底路停用观察一周后可去管理员会话依赖。
- **验收**：一张真实 vendor 单子走 happily path 全链（submit→selfcheck→onboarded）；replay cookie 兜底失败不掉单（挂 in_review 等人工理）。

## 向下兼容

本适配只增不改：cookie+CSRF 通道是补丁未发版的当前默认；切 lane 由 env 决定，两性对拉。
