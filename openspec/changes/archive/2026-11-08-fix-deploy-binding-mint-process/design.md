# 设计：铸造跑在谁那儿

## 约束

- 令牌的父凭证必须是**部署者本人**的连接器账号（既有不变量，不能放宽成服务身份）。
- 该账号只存在于**用户的 cell**（`user_connector_credentials` 在 cell 的 `app.db`）。
- 存储与下发方是 facet：`deployment_secrets` 在 `/data/facet/packs.db`，runner 经
  `/api/packs/internal/secret/<ref>` 取值（该前缀同样被代理到 facet）。
- 版本不可变、下架不等于删除；不引入第二份令牌真相。

## 选项

**A. 内部代铸通道（推荐）**
facet 在铸造前调用 platform 的内部路由（`x-facet-user` + `FACET_INTERNAL_TOKEN` 已是既有身份通道），
platform 在自己的进程里用该用户的账号铸出令牌并把**值**回给 facet；facet 照旧落 `deployment_secrets`
并下发。撤销同理（facet → platform 的 revoke）。
代价：一条新内部路由 + 一次环形调用；收益：凭据不跨进程复制，存储与下发方不变，单进程部署自动退化为直连。

**B. 把 deploy 路由从代理里摘出来，留在 platform**
存储（`pack_deployments` / `deployment_secrets` / `deployment_keys`）在 facet，迁移或双写风险高，
且与既有的"facet 拥有市场面"切分相反。否决。

**C. 让 facet 挂载 `/data/cells` 直接读 cell 库**
把用户数据目录整个暴露给市场面进程，等于取消 cell 隔离。否决。

## 判定

选 A。落地顺序：先加 platform 内部代铸/撤销路由（幂等，按 (pack, agent, key)），
再让 facet 在 `mintableBindings` 非空且本地无凭据时走该通道，最后把 `no_account` 的文案按
"进程无凭据 / 用户未连接"分档。
