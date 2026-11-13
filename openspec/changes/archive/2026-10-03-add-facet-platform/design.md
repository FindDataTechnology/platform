# Design: add-facet-platform

## Context

市场面现状：`gateway/packs.js` 的 `createPackRegistry`（自包含模块 + 独立 `packs.db`）挂在 gateway 进程（fd-prod 单进程为 server.js verbatim 复挂）；订阅为浏览器搬运（design D8，cell 与市场无服务间调用）；skill-md 公开路由匿名；萬星 facade 进程内 import packRegistry（`gateway/wanxing/index.js:69-103` 共 4 调用点）；registry 为外部自托管 OSS（`mcp.finddatatech.cloud`），MCP 连接凭据为 per-user JWT（registry SSO 铸造）。`web/src/lib/packs-api.ts` 全部市场调用为同源相对路径。决策背景见 ADR-0015 与拷问纪要（2026-10-03）。

## Goals / Non-Goals

**Goals:**

- 谦面服务可独立部署、独立域名、独立存活（壹座全停仍可用）。
- 壹座嵌入零前端改动（同源代理 + 转发身份）。
- 身份单一：同一 Logto 租户双通道，一个用户一个键。
- S0 解耦让萬星 facade 先不依赖进程内市场。

**Non-Goals:**

- registry 软件重写、域名迁移、GitOps 重组（v2，ADR-0015）。
- 公开上传（creators 白名单 v1 不变）、滥用治理工具。
- CLI 写 MCP 配置、registry SSO token 自动写入（v2）。
- DAAS 目标、自托管发行（v2+）。
- cell 安装面任何改动（浏览器搬运 D8 原样）。

## Decisions

### D1 服务形态：仓内 `facet/` 目录，抽模块不重写

`facet/` 新目录 = 入口（`index.js`：HTTP 服务）+ 复用 `gateway/packs.js` 的 `createPackRegistry`（模块本来自包含）+ `lib/pack-manifest.js`、`lib/agent-serving.js`、`lib/sub2api-admin.js` 原位复用（env 驱动）。Dockerfile + compose/GitOps 清单仿 agent-runner 先例；公开快照仓自动带出（决议：随仓公开）。
*备选*：独立新仓——抽取/CI/部署管线成本高，且 v1 无外部协作者，弃；`agent-runner` 先例证明仓内独立服务可行。

### D2 身份双通道：OIDC 自持 session + 代理转发身份

- 直连：Logto 同租户新 application，OIDC 授权码 + facet 域名自己的 session cookie；共享租户 SSO 使壹座已登录用户静默通过。
- 壹座：网关/server 在 `/api/packs` 代理点解析既有身份（复用 `resolveUser`），以内部共享 secret（`FACET_INTERNAL_TOKEN` 类）+ 转发头（`x-facet-user`：email/groups 序列化签名或 mTLS 内网直达）传给 facet；facet 仅在 internal credential 验证通过时采信转发身份，否则按匿名处理（spec 场景：伪造转发头被忽略）。
- creators 判定沿用 `PACK_CREATOR_GROUPS` ∩ groups，两通道同构。
*备选*：前端直连跨域 CORS + token 交换——要动 `packs-api.ts` 与会话引导，破坏"零前端改动"，弃。

### D3 数据迁移：`packs.db` 文件整体搬迁

schema 不动、pack id/版本/身份键不动（spec：迁移不破身份连续）。cutover 顺序：停写（壹座 `PACK_MARKETPLACE` 摘除或只读）→ 拷库 → facet 起服务 → 壹座代理指过去 → 观察后开写。订阅者 cell 的已装快照不经此库，天然无感。
*备选*：双写/在线迁移——市场写入量低（发布/订阅频率），停写窗口分钟级足够，弃。

### D4 S0 落点：先 loopback HTTP，后换 env

S0 在 gateway 既有 pack 路由上补 internal 只读三接口（部署列表 / 包作者 / 单包部署行），facade 4 调用点换成 HTTP 客户端，base URL 进 env（默认 loopback）。S1 后该 env 指向 facet 服务，S0 代码零再改。internal token 复用 D2 的共享 secret。

### D5 匿名开放面：仅 public 且未 unlisted

browse/search/detail/skill-md 在无身份时只返回 `visibility=public` 且 `unlisted=0` 的 pack；私有/下架一律缺席。速率限流沿用既有 per-IP 手段。发布/订阅/部署/deploy 管理路由照旧全认证。

### D6 registry 轻归屋：读聚合，不碰写路径

facet 服务进程内复用 `registry-bridge.js`（同 env：`REGISTRY_URL` + `MARKET_REGISTRY_TOKEN`）读 MCP 目录，UI 出卡片；可见性尊重 registry-groups 语义（匿名视角=无组，只见公开项）。不写 registry、不动其部署。DEPLOY.md 增"registry 为谦面组件"归属章节。

### D7 CLI：`@finddata/facet`，技能白名单式落盘

Node CLI（`facet/cli/` 或独立子目录，npm 发布走 OIDC trusted publishing，同 finddata 规范）。`facet install <packRef> [--target claude-code|cursor] [--project <dir>]`：拉 manifest → 写技能（Claude Code：`~/.claude/skills/<name>/SKILL.md` 或项目 `.claude/skills/`；Cursor：目标布局在实现时按其原生技能支持定，若无则降级为项目内目录 + 说明）。MCP 引用打印 `{REGISTRY_URL}/{path}/mcp` + 凭据提示，不写任何 MCP 配置。快照语义：无订阅、无更新推送。

### D8 部署：canonical 路径 + 双拓扑代理

GHA→TCR（yizuo/platform 家族镜像）→ GitOps 新 app（fd-prod 命名空间，Ingress `facet.finddatatech.cloud` + cert-manager）。壹座侧代理两处：fd-prod `server.js` 与多 cell `gateway/index.js`（同一段 mount 代码，env `FACET_BASE_URL` + internal token）；验收只做 fd-prod，多 cell 标注未实测。`PACK_MARKETPLACE` 语义从"本地市场"变"嵌入谦面"（仍控制入口显隐）。

### D9 skill-md URL 平滑：旧路由保留重定向

`AGENT_SERVING_PACKS_URL`/deploy 描述符里的 skill_md_url 切到 facet 域名；壹座旧公开路由保留 301（或双挂一个过渡窗口），registry 里已登记的 URL 不失效（spec：旧 URL 过渡期可解析）。回滚 = 代理 env 指回壹座本地市场（保留旧代码路径一个版本周期）+ `packs.db` 回拷。

## Risks / Trade-offs

- [转发身份被伪造] → internal credential 强制配对校验；公网直达 facet 时转发头一律忽略（D2/spec 场景）。
- [cutover 停写窗口撞上发布高峰] → 窗口选低峰；分钟级；失败可回拷回滚（D3/D9）。
- [多 cell 拓扑代理未实测] → 代码与 fd-prod 同源同构；文档明示未验收；出现首个多 cell 真实部署时补验。
- [Cursor 技能布局不确定] → CLI 目标层抽象成 target 适配器；Cursor 若无原生技能位，降级为项目目录 + README 说明，不阻塞 v1。
- [registry 读聚合在 facet 侧多一跳] → 300s TTL 缓存照抄 registry-bridge，无新负载面。
- [匿名开放面被爬] → 既有 per-IP 限流 + 内容本就公开可检视，风险接受。

## Migration Plan

1. **S0**（先行，独立可上线）：gateway internal 三接口 + facade 改 HTTP（loopback）→ 验证萬星 A2A 全链无回归。
2. **S1**：facet 服务 + SPA + Logto application + GitOps app + 域名 → 停写拷库 → 壹座代理切换 → 旧路由 301 → 观察 burn-in。
3. **S2**：facet UI MCP 卡片 + DEPLOY.md 归属章节。
4. **S3**：CLI 发布 + 下载面收口。
5. **S4**：壹座一键流（preset→桥→发布→部署）。
回滚：S1 后任何时刻代理 env 指回壹座本地市场；`packs.db` 双向可拷；facet 服务独立无状态副作用（除 deploy 记账，随库走）。

## Open Questions

- Cursor 的原生技能布局细节（实现 S3 时定，target 适配器隔离，不影响契约）。
- 转发身份头的具体签名形式（HMAC vs 简单 secret 头）——S1 实现时按内网拓扑定，两者都满足 spec 的"伪造被忽略"场景。
