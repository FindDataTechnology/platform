# search-relay 上游切词元：SerpAPI 供给收口到单一账号池

## Why

SerpAPI key 现在两处各持一套：search-relay 的 keys.json（集群 secret，生产还
挂着耗尽的旧 key）与词元 websearch 车道账号池（#37 新 key）。两套轮转代码、
两处额度看护、两次换 key 操作，且 relay 的轮转是进程内 Map（重启失忆）。词元
车道在 `ciyuan-lane-pool-failover` 落地后能力反超 relay（DB 冷却+admin 可见+
BYOK），收口条件成熟：**SerpAPI key 只存词元一处**。

## What Changes

- **relay 上游改词元**：`poolSearch` 的上游从直连 SerpAPI 改为词元
  `POST /v1/search`（固定 engine=serpapi、信封拆包回 `{results}`），
  凭词元**内部专用 key**（internal 组、websearch 价格 0、计量保留）。
- **对外契约零变化**：`POST /v1/search {query,num}`、Bearer/wrcp scoped token
  鉴权、`/v1/stats`、per-token 日限、缓存——cells、websearch-mcp、设置面板
  全部无感。
- **BYOK 透传**：`X-Serpapi-Key` 原样转发词元（车道侧实现覆盖语义），
  `x-search-source` 三态透传回调用者。
- **冷备回退窗口**：直连 SerpAPI 路径保留为 fallback（词元不可达/5xx 时切回，
  来源标注 `ciyuan-fallback-direct`）；稳定一个窗口后另起退役清账。
- **keys.json 形状变更**：`serpapi[]` 降为冷备角色，新增 `ciyuan:{url,key}`；
  secret 同步更新（含换新 key 的既定动作）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `web-search`：①MODIFIED「Shared pool health」——池健康语义从「relay 自持
  per-key 冷却」改为「上游=平台网关车道的池健康（可达性/车道错误计数/冷备
  路由标注）」；②ADDED「共享搜索供给由平台网关车道承担」——共享池 SHALL 经
  词元 websearch 车道服务、SerpAPI key 只存词元账号池、直连仅作冷备窗口。
  其余 11 条 requirement（工具契约/凭据卫生/BYOK 三态/来源披露/会话开关）
  明确不动。

## Impact

- `services/search-relay/index.js`（poolSearch 改造+透传+回退）、
  `fd-infra-deploy/all-services/prod/search-relay.yaml`（ConfigMap 代码内嵌
  同步+secret keys.json 形状）。
- 词元侧前置动作：建 internal 组（价格 0）+ 内部 key——纯 admin 配置零代码。
- 依赖：**前置 change `ciyuan-lane-pool-failover` 上产**（BYOK+轮转是切换的
  能力前提）。
- docs：DEPLOY.md websearch 节、`docs/sub2api-fork-patches/README.md`（台账
  收口记录）、ops 面板文案不动（stats 语义不变）。
- 内部消费计费口径（已定）：internal 组价格 0、计量保留——成本可见性=用量行数。
