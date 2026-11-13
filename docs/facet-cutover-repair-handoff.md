# 转接：facet cutover 修复实录（spider-heal 会话 → 谦面会话）

> 2026-10-03 晚，萬星 spider-heal（C0）在 fd-prod 实跑 v2 部署时发现并修复了 **add-facet-platform
> S1 cutover 的两处隐患**。本文档供谦面会话在 S2/S4 收口时对照核查。相关提交：
> GitOps `aa60f6f`（facet.yaml）；paas `a7dfaf1`（追记）/ `3a0f2c1`（spider-heal 归档）。
> 相关文件：`facet/index.js`、`gateway/facet-proxy.js`、`gateway/packs.js`、`docs/spider-heal-pack.md`。

## 0. 背景一句话

`/api/packs` 全前缀已由网关代理到独立 facet 服务（`FACET_BASE_URL` 设时，见 `gateway/facet-proxy.js`），
facet 使用**自有 store**（`FACET_DATA_ROOT=/data/facet` ← hostPath `/opt/platform/facet`，同节点
hostNetwork）。spider-heal v2 部署经这条代理链时 404，顺藤摸出下面两坑——都只在「真部署一次」时显形。

## 1. 数据迁移漏私有行（已回填，两库已对齐）

**现象**：`GET /api/packs/KkCie7NlrHluo4LiKPnn0w` 经代理 404；facet 库只有 5/7 个包。

**漏项（cutover 拷贝只带进 public）**：
- `packs`：2 个私有包漏拷 —— `KkCie7NlrHluo4LiKPnn0w`（spider-heal）、`99UMqIqxF5tpRUgL6SIFag`
  （C2 probe 遗留），**均属 admin@finddatatech.cloud**；
- `pack_versions`：两包 v1 行；
- `pack_deployments`：`KkCie/spider-heal`、`99UMq/probe-agent` 两行；
- `deployment_keys`：**全表为 0** —— 连在线演示包 `vtdps…/pack-demo-fingpt` 的计费键簿记都在漏列；
- `deployment_secrets`：1 行（99UMq 的 probe 假值）。

**修复（已执行）**：在 platform pod 里一次性回填（hostPath 让两库同进程可见：
`/data/cells/packs.db` → `/data/facet/packs.db`）。算法：`packs` 按 `id`、其余按 `pack_id` 过滤；
列集取**目标表 `PRAGMA table_info` 交集**（防 schema 漂移）；逐行 `INSERT`（PK 已存在则跳过）；
跑完 7 表计数全对齐。`sub2api_accounts`（3 vs 0）**有意不拷**：部署路由
`findUserByEmail` + `saveBillingAccount` 会自然重建。

**待办（给你们）**：
1. 2.7 的验证方式从「抽样比对」升级为**全表 diff**（7 张表，两库逐行比对；本仓现在这条命令跑得出全绿）；
2. S2/S4 若再动 store 结构（如 registry 轻归屋涉及新表），收口前再过一遍全表 diff。

## 2. facet 部署缺 SUB2API_ADMIN_KEY（已修 + 已持久化）

**根因**：k8s `envFrom` **静默跳过非法 env 名的 secret 键**（事件里才有 warning）。
`platform-secrets` 11 个键中只有 `sub2api-admin-key` 带破折号 → 平台靠 inline
`valueFrom.secretKeyRef` 拿到，facet 只有 `envFrom` → **拿不到**。

**后果（比 404 更重）**：facet 侧 `deployConfig.sub2api=null` → 部署路由走 "billing not linked"
（仅 warn、不报错，`gateway/packs.js` billing 块）：
1. 粘贴的 `billingKeys` 被静默忽略；
2. **重新部署会把 serving agent 描述符里的 `billingKeyRef` 抹掉**（`gateway/packs.js:972`
   条件展开 `...(billingKeys[id] != null ? { billingKeyRef } : {})`）→ 在线服务丢部署键。
   即：**任何一次经 facet 的重复部署都在悄悄拆计费绑定**，且无告警。

**修复（已执行）**：`all-services/prod/facet.yaml` 补 inline `secretKeyRef`（GitOps `aa60f6f`），
已随 `sha-3125710` 滚动生效（现役 facet pod `printenv SUB2API_ADMIN_KEY | wc -c` = 71 实证）；
你们的 `cb49a2d` 在我的 commit 之上，未被覆盖。

**待办（给你们）**：
1. 审计同款陷阱：凡 envFrom 来源里键名带 `-`/`.` 的，一律改 inline `valueFrom`
   （platform-secrets 只有这一颗雷，configMap 键名合法；新增 secret 键时同理自查）；
2. 建议加一条部署回归断言：**同版本重复部署后描述符 `billing_key_ref` 不变**
   （这行断言直接封死本类事故）；
3. DEPLOY.md / 运维手册补这条 k8s 陷阱（S4.2 改写 pack-marketplace.md 时顺手带上）。

## 3. 通知链路：滚动窗口内 relay 503 即丢（记录在案，可选改进）

- **现象**：平台 pod 滚动窗口内，child 的 `bot_notify` → relay 503；C3 纪律=单次不重试 → 通知即丢
  （`/data/notify.jsonl` 实证 `outcome:"failed","reason":"relay 503"`）。spider-heal 合成冒烟的
  终态通知恰逢滚动，丢了一条。
- **复测 recipe（滚动结束后直发，实证 ok）**：platform pod 内
  `curl -X POST 127.0.0.1:3100/api/bots/relay/send -H "Authorization: Bearer $BOTS_RELAY_TOKEN" -H "Content-Type: application/json" -d '{"channel":"test-channel","text":"…"}'` → `{"ok":true}`。
- **可选改进（不阻塞）**：runner notifier 对 5xx 做一次短退避重试（注意 <6/min 限流窗口）；或
  运维纪律「重要通知避开部署窗口」。

## 4. 环境事实（本次实测，供 S2/S4 参照）

| 事实 | 值 |
|---|---|
| 代理 | `/api/packs` 全前缀（含 internal 路由）由网关代理到 facet；身份=网关 `resolveUser`（Logto cookie 或 MP Bearer）→ `x-facet-user`/`x-facet-token` |
| facet store | `FACET_DATA_ROOT=/data/facet` ← hostPath `/opt/platform/facet`（节点 liuliangjkiimypbdzxa，hostNetwork） |
| 部署写注册处 | `REGISTRY_URL`（platform-config）= `https://mcp.finddatatech.cloud` |
| sub2api | 节点 `127.0.0.1:32080`（hostNetwork 共享，facet/platform 均可达）；面板 token.finddatatech.cloud |
| 面板/日志 | runner `meter.jsonl` / `notify.jsonl`（cheap1 `/data`）；child 凭据 `…/.credentials.yaml` |
| 实跑验收线 | runner 日志「running on its own billing key (pk_…)」+「pinned N deployment secret(s)」；child `.credentials.yaml` refs 就位 |

## 5. 本次全链实证（spider-heal v2，可复刻）

v2 发布+部署（facet 侧路由）→ 描述符含 `secret_refs`/`notify_channel` → runner 原地 drain 换新
child（billing key ref **保留**：`pk_e19083b4…`）→ child 凭据文件 `git_pat`/`gh_actor` 就位 →
门面合成工单**真回合 110s** → 终态 `manual`（工单不可读，四路核实）→ 同 `Idempotency-Key`
重放返回首答、**仅一笔账**（`wanxing_usage` settled 实锤）。finddata 契约见 `docs/spider-heal-pack.md`。

## 6. 给谦面会话的动作清单

- [ ] 全表 diff 复跑一次（期望全绿；`sub2api_accounts` 差异为已知可容忍项）
- [ ] 部署回归断言：重复部署后 `billing_key_ref` 不变（建议进测试）
- [ ] envFrom 破折号键自查（新增 secret 键时）
- [ ] DEPLOY.md / pack-marketplace.md（S4.2）补 k8s envFrom 陷阱与迁移全表 diff 纪律
- [ ] S2 registry 轻归屋若引入新表/新 store，按 §1 纪律过全表 diff