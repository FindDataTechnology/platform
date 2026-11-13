# 词元月度合并窗 runbook（sub2api 增量谱系 fork）

> 适用：FindDataTechnology/sub2api（词元 fork，ADR-0024）。配套台账
> `docs/sub2api-fork-patches/README.md`（§一发布记录 / §二缝点表 / §三窗台账 /
> §四 CI 出片 / §五上游回馈）。出片通用纪律见 skill `tcr-image-pipeline` 与
> `deploy-registry-image`；本文件只写词元谱系专属流程。
> 全部配方均为 2026-10-14 首窗（v0.2.16 谱系奠基 + §2/§3 车道）实证。

## 0. 窗类型与触发

| 窗型 | 触发 | 时限 |
|---|---|---|
| 常规月度窗 | 每月一次；上游有新 tag 才产出发布 | 当周内完成 |
| 安全快车道 | 上游 release notes 含安全字样（见 §5 清单） | **天级**（不等月度窗） |
| 无增量 | 月度窗时上游无新 tag | 台账记「无上游增量」，不产空发布 |

## 1. 读 notes 与预判

```bash
# 上游最近发布（看 body 找安全字样/破坏性变更/DB 迁移）
gh api repos/Wei-Shaw/sub2api/releases --jq '.[0:5][] | .tag_name + " | " + .published_at' \
  -X GET --paginate=false
gh api repos/Wei-Shaw/sub2api/releases/tags/<新tag> --jq .body | head -60
```

预判三件事，任一命中记入当窗备注：
- **安全字样** → 直接转安全快车道（§5）；
- **破坏性变更/DB 迁移** → 读升级指南，核对生产 env（AUTO_SETUP/ADMIN_EMAIL 等
  显式项）；迁移文件编号从 `backend/migrations/` 现有最大号 +1 起；
- **平台清单/ent schema 变更** → 预告金样同步面（§4 步骤 5）。

## 2. merge 上游 tag（fork 仓，本地）

```bash
cd ~/finddata/sub2api
git fetch upstream --tags
git checkout main && git pull origin main
git merge upstream/<新tag>            # 冲突应只在台账§二缝点文件内
```

**冲突纪律**：冲突仅允许出现在台账§二登记缝点（gateway.go / openai_gateway_handler.go /
openai_gateway_service.go / domain/platforms.go / scheduler_snapshot_service.go /
upstream_billing_probe.go / 分组价目链 / platforms_test 等）。**缝点外冲突=纪律违规**：
停下来回查原因、补登记缝点，再继续。

```bash
git diff ciyuan-v<旧>-N --stat | grep -v '^ backend/internal/lanes/'   # 缝点面复核
```

merge 用时从本节开始计（台账§三「merge 用时」字段，>1 天触发§7 检查点）。

## 3. 缝点解冲突与迁移跟进

- 逐缝点解冲突：**只增不改**——上游逻辑照收，fork 插入块保持最小（gateway.go
  400 字符源码断言窗口内只留一行注册调用，构造挪窗口外）。
- 上游新增 ent 字段/schema：`cd backend && go generate ./ent`（生成物全量提交）；
  新迁移 SQL 编号顺延（首个 fork 迁移=246_group_rerank_price_per_request.sql）。
- **快照形状变更必升版本号**（v0.2.16-3 生产实证坑）：给 `APIKeyAuthSnapshot`
  （`api_key_auth_cache.go`，或任何带 `Version` 门禁的缓存形状）加字段时必须
  同步 `apiKeyAuthSnapshotVersion++`（当前 v25），否则滚产窗口内 Redis L2 的
  存量快照按旧形状反序列化——新字段静默 nil（rerank 价目配着仍计 0 的实锤：
  用量行 92221，同批 audio 正确=恰逢缓存重建）。同型检查：调度快照、
  `GatewayCache` 内的组/键形状。
- 车道平台登记若上游改了平台清单派生函数：**车道平台谓词排除**（schedulerSnapshot
  / billingProbe）必须跟住，否则 8MB 内存界与探测外发回归。

## 4. 上游 CI 等价 + 车道测试（本地轻测 + CI 重测）

本地只跑快包（用户纪律：重测试上 CI）：

```bash
cd backend
GOPROXY=https://goproxy.cn,direct go build ./...
GOPROXY=https://goproxy.cn,direct go test ./internal/lanes/ ./internal/domain/ ./internal/server/routes/
gofmt -l internal/ ent/    # 应为空
```

重测（unit 全量）走 CI：快照推 law-ai 线后 test job 自动跑
`go test -tags=unit ./...`（go 1.27.0 钉版，见§四坑）。

**金样同步面（动了平台清单/API 形状时逐处核对）**：
1. `internal/domain/platforms_test.go`（display/composite 清单按位补入）
2. `internal/service/platform_list_test.go`（legacy 三清单+谓词探针）
3. `internal/service/composite_platform_test.go`（调度桶清单）
4. `internal/service/channel_service_test.go`（composite 匹配清单）
5. `internal/model/error_passthrough_rule_test.go`（AllPlatforms）
6. `internal/server/api_contract_test.go`（组对象新字段+default_platform_quotas 键）
7. `frontend/src/constants/platformCatalog.builtin.json`（手写同步或
   `UPDATE_PLATFORM_CATALOG=1 go test -tags unit ./internal/service/ -run TestFrontendBuiltinPlatformCatalogInSync`）

## 5. 安全快车道判据（独立于月度窗）

**触发字样**（notes 标题/正文命中即触发，宁多勿漏）：
- 凭据类：默认管理员/默认密码/default credentials/硬编码密钥
- 支付类：支付回调/payment callback/webhook 伪造/签名绕过
- 认证类：爆破/brute force/会话固定/越权/privilege escalation/鉴权绕过
- 通用：CVE-/GHSA-/security advisory/vulnerabilit/漏洞/越权/RCE/SQL 注入

**动作**：直接执行本 runbook §2-§8 全流程（不等月度窗），台账§三当窗行备注
「安全快车道：<触发事由>」。历史欠账已在首窗（v0.2.16）还清（0.2.14 默认
管理员可爆破 + EasyPay 回调伪造、0.2.12 验证码爆破）。

## 6. 出片（ciyuan-tag → 快照 → relay）

```bash
cd ~/finddata/sub2api
printf 'ciyuan-v<上游X.Y.Z>-<N>' > ciyuan-tag   # N=fork 补丁级（首窗起 1；dev 片 devN）
git add -A && git commit -m "chore(release): <tag>——<窗内容>" && git push origin main

fd-build-snapshot ~/finddata/sub2api -R law-ai-official/sub2api-images
# ⚠️ 不要传 --keep-workflows！该旗标语义=「同步源仓 .github」（会删 image.yml
#    并触发上游四套 workflow 烧额度）；默认（不传）才是保护镜像仓 workflows。
```

- 快照=rsync --delete 镜像：fork 仓根额外文件（ciyuan-tag）自然携带；
  **别在镜像仓手加文件**（下窗被删）。
- 出片 tag=快照仓 commit 短 sha；等 relay ≤5 分钟回灌 ccr。
- 语义 tag 只是命名锚点（relay seen 账本挡同 tag 覆写）——**部署永远引 sha tag**。

## 7. 部署与探针（生产滚动）

```bash
# 1) bump 镜像（fd-infra-deploy，gitee 为真源）
cd ~/finddata/fd-infra-deploy
#    改 all-services/sub2api/01-sub2api-deployment.yaml: image=…:sha-<新>
git add all-services/sub2api && git commit -m "sub2api: sha-<新> (<新tag>) — <窗内容>"
git push gitee main

# 2) 等自动同步 —— 通常**不需要**手动 sync
#    实测（2026-11-10，ciyuan-v0.2.19-2 窗）：本 app 的 syncPolicy = {"automated":{}}
#    = 清单一变即自动同步；selfHeal / prune 均为 false（缺省），即手工漂移不会被拉回、
#    删除的资源不会被自动清理。故 push 完直接等 rollout。
kubectl --context cheap-ts -n argocd get application sub2api \
  -o jsonpath='{.spec.syncPolicy}{" | "}{.status.sync.status}{"\n"}'
kubectl --context cheap-ts -n sub2api rollout status deploy/sub2api --timeout=300s
```

> ⚠️ **两处历史漂移（2026-11-10 订正）**：
> ① 旧文写「必须 `argocd app sync`」——在 `automated:{}` 下该步**冗余**；仅当想强制拉一次、
> 或 automated 被关掉时才需要（真要用则 in-pod 必带 `--server localhost:8080 --plaintext`，
> 命令挂 websocket 属正常，sync 已执行）。
> ② 旧文的 `--context cheap` 当前指向一个未起的隧道（`127.0.0.1:16443` 拒绝连接）；
> 本集群请用 **`cheap-ts`**。

探针四件套（全绿才可关窗）：
```bash
# ① /health
kubectl --context cheap -n sub2api exec deploy/sub2api -- wget -qO- http://localhost:8080/health
# ② 版本端点（admin key=x-api-key 头；key 在 mcp-registry ns 的 auth-server secret）
KEY=$(kubectl --context cheap -n mcp-registry get secret mcp-registry-env-auth -o jsonpath='{.data.SUB2API_ADMIN_KEY}' | base64 -d)
kubectl --context cheap -n sub2api exec deploy/sub2api -- wget -qO- --header="x-api-key: $KEY" \
  http://localhost:8080/api/v1/admin/system/version     # 应自报 <新tag>
# ③ 公网门面 200（token.finddatatech.cloud）
# ④ 日志零 panic + 真 chat 回合 200（自然流量或手打一笔）
kubectl --context cheap -n sub2api logs deploy/sub2api --tail=200 | grep -ciE 'panic|fatal'   # 应为 0
```

**车道窗附加探针**（动了 lanes 时）：管理面建/核车道上游账号（siliconflow/serpapi
平台）+ 分组配车道价目（rerank_price_per_request / WebSearchPricePerCall / 音频
三价）→ 三车道各一笔真回执 → 用量面板见车道行（单位标注）+ 余额扣减。

## 8. 台账登记（关窗动作）

台账 `docs/sub2api-fork-patches/README.md` 追加：
- §一 发布记录一行（tag/基线/内容/验收证据链）；
- §三 窗台账一行（上游 tag、产出 tag、缝点冲突清单、**merge 用时**、探针结论、备注）；
- §二 缝点表若有集合变更（新增/退役缝点）同步登记；
- 安全快车道窗在备注写明触发事由；无增量窗记「无上游增量」。

## 9. 三月检查点记分（降级决策）

规则（ADR-0024 / spec）：连续三个月度窗记录 merge 用时；**单窗 >1 天** → 触发
显式降级决策（三选一，记台账§三检查点表，不允许无决策硬扛）：

| 选项 | 含义 | 何时选 |
|---|---|---|
| 继续 | 保持月度窗节奏 | 偶发一次、根因已定位（如上游大重构一次性摩擦） |
| 冻谱系 | 转 ADR-0017 模式（安全单行道，只跟安全修复） | 连续两窗 >1 天且缝点冲突面持续扩大 |
| 车道外提 | 三车道拆为独立服务，fork 退回近上游 | 冲突集中在车道能力且拆出成本可控 |

## 10. 上游回馈（能上游则上游）

普适补丁以独立可 cherry-pick 提交推上游 PR（需签上游 CLA.md）；上游合入后
下个月度窗退役本地对应补丁（fork diff 只许缩小方向的变更无需额外决策）。
当前候选与状态见台账§五。
