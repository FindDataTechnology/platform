# 智语官网 · 交付包与上线补给单

> 生成：2026-10-30（paas 私有仓）。本文是**给雷池侧运维 AI 的执行附件**，正文规范见
> `docs/zhiyu-site-deploy-requirements.md`。本文只补三件：交付物清单、补给包、上线后的
> demo 房间启用单（可选）。

## 一、交付物清单

| 交付物 | 路径（本仓） | 是否上产线静态目录 |
|---|---|---|
| 智语站三文件 | `site-zhiyu/{index.html,style.css,script.js}` | ✅ 是（唯一要发布的东西） |
| 永忆站回链改动 | `../fd-memory/site/index.html`（两处：导航「智语」+ 页脚一行） | ✅ 是（与智语同批） |
| 部署需求 | `docs/zhiyu-site-deploy-requirements.md` | ❌ 否 |
| 设计记录 | `docs/zhiyu-site-design.md` | ❌ 否（含内部词清单） |
| design surface brief | `.impeccable/surfaces/site-zhiyu-index-html.md` | ❌ 否 |

## 二、补给包（唯一推荐通道）

> 当前包 sha256：`f3f41e073f5f05969ada1104143f48e6a5890667cc77866ca46a1e7f2cd46e37`（12,598B 左右，3 个文件）。重打包后必须重算并回填此行。

**不要用 raw.githubusercontent.com**（雷池机与 cheap1 实测被 SSL 重置）。二选一：

```bash
# A. 随本文附带的 tar（推荐，最小面）
tar -czf /tmp/zhiyu-deploy-20261030.tar.gz \
    -C /Users/chengsishi/paas/site-zhiyu index.html style.css script.js
shasum -a 256 /tmp/zhiyu-deploy-20261030.tar.gz

# B. 走仓库（已推送分支 feat/zhiyu-official-site）
curl -L -o /tmp/paas.tar.gz \
  "https://codeload.github.com/FindDataTechnology/fd-craw-private/tar.gz/refs/heads/feat/zhiyu-official-site"
```

三个文件的独立哈希见 `docs/zhiyu-dns-and-edge-request.md` §6（取到后应逐一核对）。

雷池机侧：

```bash
mkdir -p /srv/zhiyu-site && tar -xzf zhiyu-deploy-20261030.tar.gz -C /srv/zhiyu-site
ls -l /srv/zhiyu-site      # 期望：恰好 index.html style.css script.js
caddy reload --config /etc/caddy/Caddyfile
```

## 三、上线核对单（逐条打勾）

- [ ] DNS：`dig +short zhiyu.finddatatech.cloud` → `103.236.89.212`
- [ ] 证书：`curl -sI https://zhiyu.finddatatech.cloud/ | head -1` → `200`
- [ ] 标题：响应体含 `<title>智语 · Zhiyu`
- [ ] 首屏句：响应体含「让智能体团队」
- [ ] 泄漏门：`grep -cE '壹座|yizuo\.local|10\.43\.|NodePort|31899|sub2api|spider-heal'` → 0
- [ ] 合成标注：响应体含「合成」（≥1 处）
- [ ] 视觉桌面：滚动时圆桌依次转向 分身席 → 访客席 → 门口 → 桌心
- [ ] 视觉移动：390px 下章节顺排、席标可读、首屏 H1 与两个按钮在位
- [ ] 互链：yongyi ⇄ zhiyu 双向可达
- [ ] 永忆站：导航与页脚各出现一处 `zhiyu.finddatatech.cloud`

## 四、可选：把活演示变成真房间

不做也能上线（页面会明确标注「合成演示」）。要做，按顺序：

1. **造房**：用普通用户账号在万星建一间房，命名「智语值守」，配置空闲结束时长。
2. **部署值守分身**：走正常创建 → 部署路径（内部＝范例，无后门）。人格提示词要点：
   只答智语/万星的产品问题；不确定就转人工（事项串）；不泄漏任何内部实现。
3. **开嵌入**：房间设置 → 开启嵌入 → 域名白名单填 `zhiyu.finddatatech.cloud`
   （本地自测可加 `localhost`）。**未填白名单无法开启**，这是既有闸。
4. **配护栏**：日预算（小额起步）、应答上限、熔断；模型钉 `:free` 车道。
5. **取令牌**：平台生成 widget 令牌（≥128 bit，平台存哈希）。把令牌写进
   `index.html` → `<div class="room-shell" id="liveRoom" data-room="<令牌>">`，重新上传该文件。
6. **回填验收**：页面上传后，该区应出现真 iframe；提问一句收到回复即通过。
   `script.js` 在挂载前会自动移除合成对话与「合成演示」标注——若标注没消失，说明 widget 未加载。

**安全边界（写死的）**：令牌公开可见是设计如此（防猜靠长度、授权靠白名单、吊销靠休克）。
**绝不要**把任何带写权限的凭据写进这三个静态文件。

## 五、回滚

```bash
# 站侧
cp /srv/zhiyu-site/index.html.bak-pre-20261030 /srv/zhiyu-site/index.html && caddy reload
# 或整站下线：删 Caddyfile 块 + reload，再删雷池 site；DNS A 记录 TTL 600s 内失效
```


---

## 七、§四 runbook 实际执行结果（2026-10-30 第二班补记）

按 §四 跑完，**三处与预案不同，均已在产**：

1. **在席 2 席，不是 6 席**。官方包六岗无 serving 契约不可部署；已铸**镜像私包**
   `bTnrv2P_JhmCzqqXCF0GIA`（岗位文案与官方 v5 逐字一致 + 六岗补 serving），
   部署时 **runner-serving 32 端口槽已满**（registry 34 条含同主机 untagged；fleet 名册里
   `runner-b`/`runner-c` 两台无 pod＝死行，无处可放），只落两席：
   `intro-guide`（产品向导）+ `intro-yizuo`（壹座专家）。余四席等端口，不是等代码。
2. **车道改选**。契约声明 `toolFace:"chat"` + 回合预算 3 分钟；模型先钉 `:free`
   （`google/gemma-4-31b-it:free`）实测持续 429/502，改钉 `deepseek-v4.1-flash` 后真答。
   注意模型有**两道闸**：计费车道白名单 ∩ **runner 名册**，后者更窄（名册实得 8 个模型）。
3. **嵌入白名单必须两条域名**：`zhiyu.finddatatech.cloud`（父站 meta 门）
   **＋ `platform.finddatatech.cloud`**（iframe 自身同源请求的 referer 落点）。
   只放前者→访客铸席 403（仓内 e2e 用伪造 referer 掩盖了这点，真机才露）。

房间 = `zy_42ce690574b5423bd2`，房主 `zhiyu@finddatatech.cloud`（对外角色地址，
访客头一行会原样显示房主邮箱，所以不能是个人邮箱）；`replyCap=1`、日预算 60 应答；
`idle_minutes` 直写 5256000 豁免闲置收房（API 上限 1440＝24h，常设展厅不该被临时房规则掐死）。

真机验收：真域 iframe 内未登录访客提问 → 产品向导真应答 →
`reply_cap_hit` 如实收住第二席。房间与令牌在平台侧，静态件回滚不影响它。


## 八、四席扩容：为什么没能落，以及回退了什么（2026-10-31）

**结论先说**：官网房间保持 **2 席**（产品向导 + 壹座专家），已上线并在真站验过应答。
余 4 席不是「再点一次部署」能解决的，它撞的是**容量与规划模型**，不是权限也不是代码。

### 8.1 一次错误改动（已回退，留作判据）

我依据「registry 全部条目都带显式 `port_override`」这个读数，把 runner env 与名册行
`port_span` 一并 32→64，理由是「runner 照记录端口绑，拓宽只扩新席位的规划窗」。

**那个读数是假的**：脚本按 `data.items` 解析，而 registry `/api/agents` 的真实结构是
**顶层 `agents`**，取到空数组，于是「0 条没有 override」被误读成「全部都有 override」。

**实测真相**：37 条里只有 **14 条**带 `port_override`，其余老条目实际绑在 `hash%32` 的
位置。网关改按 `%64` 规划后，把「其实已被占用」的槽当成空槽 → 该路径注册**悬挂**，
边界报 `registry POST /api/agents/register failed (504): {}`；**改前是快速且诚实的
400 `port span exhausted`**。

回退动作（全部已执行并复验）：
- 清单 `AGENT_RUNNER_PORT_SPAN` 回 32 — GitOps commit `d653491`，已 apply + rollout；
- 网关名册行 `agent_runners.port_span` 回 32（两侧必须一致，否则就是 co-host 撞车）；
- 镜像包可见性回 `private`（期间为验证假设临时改过 `public`+`unlisted`，已复原，
  确认它没有出现在公开市场）；
- 回退后真站复验：iframe 挂载、访客提问、产品向导真应答、`replyCap` 收口、零 JS 错。

**三条判据入册**：
1. 解析外部 API 响应前先打印顶层键，别假定 `data.items`；空数组 ≠ 全满足。
2. `%span` 哈希让「端口规划空间」依赖 span 值本身——改 span 是**重排**不是扩容，
   只在全条目都有显式 override 时才安全。
3. 失败形态的退化本身是信号：400（诚实拒绝）→ 504（悬挂）就说明改动是错的。

### 8.2 四席真正缺什么

| 约束 | 实测值 | 结论 |
|---|---|---|
| 端口规划窗 | 32 槽，37 条条目（其中 14 条显式 override） | 已满；扩窗要先解决无 override 条目的规划可信度 |
| runner 内存预算 | `AGENT_RUNNER_RESIDENT_BUDGET_MB=3328`，单 child≈540-600MB | 约 5-6 个并发，现已在跑 3 个 |
| pod 共宿资格 | 要求同包**共用**计费钥匙；部署门禁是「一席一键不可重复」 | `bTnrv2P` 被判 `pod-ineligible — members serve solo`，六席＝六个 dsh 进程 |
| 备用 runner | `runner-b`/`runner-c` 是**缩零的活部署**（不是死行） | 缩零本因见 GitOps `5fc4d8b`：配额耗尽曾卡住 fd-paper-trading 滚版 |
| 命名空间配额余量 | limits.memory 仅剩 **288Mi**、limits.cpu 剩 **700m**、pods 剩 5 | 塞不进 2Gi runner pod |
| 节点真实余量 | cheap-4/6/7 均 8GB，可用 3.9-4.4GB | cheap-6 是控制面，不宜再压 runner |

三条可行路线（都要先拍板，不宜静默动）：

- **A · 抬配额复活 runner-c（cheap-7 worker）**：GitOps 改 `compute-quota.yaml`（+2~4Gi）
  + `agent-runner-c` replicas 0→1 + 镜像从 `sha-51c33c3` 升到与 serving 同代 +
  名册行 `port_span` 到位。爆炸半径最小（不碰在服 30 个 agent），但动集群配额。
- **B · 抬 runner-serving 内存 + 扩窗**：`4Gi→6Gi`、span 扩窗须配套把无 override 条目
  逐个补 override（一次性重指 23 条）。最彻底，也最重。
- **C · 六席共宿**：让同包共用一把计费钥匙以取得 pod 共宿资格 → 六席摊一个 dsh 进程，
  内存问题基本消失。但要改「一席一键」这条计费归属纪律，属平台级决策。

### 8.3 遗留 1 条：`intro-lex` 半部署 —— **已于 2026-10-31 证伪并关账**

原判断（当日）：`intro-lex` 有 `pack_deployments` 行与 registry 条目，但 runner 报
`listener ... NOT serving on :8815 — port 8815 already in use`（8815 是别家包
`reception` 的 override），需 admin 才能 `kill` 掉残留行。

**复盘：这条判断是错的，且"待办"本身不存在。** 直接查库：

```
intro-facet = 1 行   intro-guide = 1 行   intro-lex = 1 行
intro-wire  = 1 行   intro-yizuo  = 1 行
```

每席各一行，`intro-lex` 与其它席结构**完全一致**，没有重复行、没有半部署。
当时把「`deployment_keys` 里查不到这一行的 key」误读成了「部署残缺」——
那 20 条 key 行是历史格式，intro 五席都不在其中，而它们的服务一直是好的
（真机 `seq=78/80` 实答）。

端口冲突也已被路线 A 自然消解：`intro-lex` 重投到 runner-c 落在 **`:8915`**
（不是原登记的 8815），`intro-wire` 在 `:8903`，两席均 `serving` 且
registry `health_status=healthy`。**`kill` 从未被需要。**

**教训**：「某张表里没有某行」不等于「对象残缺」。判部署完整度要看
`pack_deployments` 的行数与结构，更要看**服务是否真的应答**——
后者才是对外事实，前者只是账面。


## 九、路线 A 执行结果：runner-c 复活成功，两席被计费门 park（2026-10-31）

### 9.1 做了什么（全部已上产，GitOps 提交 `8bd55e0`，推 gitee main — Argo 的源）

| 动作 | 值 | 状态 |
|---|---|---|
| `compute-quota.yaml` `limits.memory` | 30Gi → **32Gi**（cpu/pods/requests 三项未动） | 已同步（used 31968Mi/32Gi） |
| `agent-runner-c.yaml` `replicas` | 0 → **1** | pod `1/1 Running` |
| `agent-runner-c` 镜像 | `sha-51c33c3`（落后 18 天）→ **`sha-90275ea`**（与 serving 同代） | 同代，避免两分片对新 registry 契约判读不一致 |
| `intro-lex` / `intro-wire` 投放 | `runnerId=runner-c`，registry 确认 `runner=runner-c`、绑定 `:8903` 等 | 端口无冲突 |
| 两席邀入房间 | 已接受 | 在席：产品向导 / 壹座专家 / 识律专家 / 柏讯专家 |

**关键前置核对**（上次端口事故的必查项）：runner-c 的 secret 里 `AGENT_RUNNER_PORT_BASE=8891`、`SPAN=32`，
与网关名册行 `agent_runners.port_base=8891, port_span=32` **完全一致**——所以不需要像上次那样改 span。

### 9.2 两席被 park：`INVALID_API_KEY` 的真伪

真站点点名 `@识律专家` 两次失败，错误逐层暴露：

```
第一次  A2A: Connection error.
第二次  A2A: agent parked: key-invalid (INVALID_API_KEY) since 2026-10-30T21:17:02.092Z
runner  parked — the billing gate rejected its key (key-invalid); inbound turns fail with -32012
        until the gate accepts the key again
```

但直接探这四把钥匙：**全部 `live=true`、owner 均为 `aloadtree@gmail.com`（部署者）**。
所以**不是钥匙失效，是 runner-c 这一侧的计费校验判它无效**。

两分片的环境差异就是嫌疑面：

| 项 | runner-serving | runner-c |
|---|---|---|
| `AGENT_RUNNER_MODEL` / `AGENT_RUNNER_PROVIDER` | 未设 | **已设** |
| `LLM_PROVIDERS_STORE` + `llm-providers.json` 挂载 | 无 | **有** |
| `AGENT_RUNNER_RESIDENT_BUDGET_MB` | 3328 | **768**（仅够 1 个 ≈600MB 的 dsh 进程） |

**未继续改**：再动就是在共享分片上猜。修复方向二选一——
(a) 对齐 runner-c 的 LLM 来源（统一 `llm-providers.json` 与 serving 的上游口径，或摘掉该挂载让它走同路径）；
(b) 若上游口径必须以「部署时那把 sk- 钥匙」为准，则检查该 store 里映射是否缺 provider 条目 → 401 被译成 `key-invalid`。
改完重启 runner-c，parked 态即清（自愈是同一次 reconcile 里做的），再复测点名。

### 9.3 配额的账（含一处我先前判错，已更正）

- **判错并更正**：我一度把 `fd-info` cron 作业失败归因于自己的配额改动。查事件后实为
  **`limits.cpu=1` 超限**（`used 22800m/23`），CPU 我根本没动，属**既有**问题。
- **确实欠的账**：2Gi 吃掉了内存余量，现 `used 31968Mi / 32Gi`，**1Gi 的作业已放不下**
  （31968+1024 > 32768）—— 与当年 `5fc4d8b` 缩零 runner-b/c 的原因同形。
  还账二选一：runner-c `limits.memory` 2Gi→1.5Gi（够 1 个 dsh 进程），或配额再抬 2Gi。

### 9.4 回退

`agent-runner-c` replicas 回 0 + `compute-quota` 回 30Gi（同一 commit 内两句，Argo 自愈即生效）。
**房间两席（产品向导/壹座专家）完全不受影响**——它们在 runner-serving 上，本次未触碰。

### 9.5 对外影响：无

官网真房间仍是 **2 席正常应答**（多轮真站复验通过、零 JS 错）。
识律/柏讯在席但停用，访客点名得到「接待席位暂时无法应答」的**如实**提示——按
`fleet-room-bridge` 的纪律，这比装作能答更正确。

---

## 十、key-invalid 阻断的根因与修复（2026-10-31 收口）

### 10.1 根因（实测，非推断）

runner-c 把 Secret `agent-runner-llm` 挂到 `/data/llm-providers.json`，**覆盖**了磁盘上
的现行版本。那份 Secret 是 **2026-09-30 的快照**，其中的 `finddata` apiKey 早已轮换失效。

分片内原地 `GET {baseUrl}/models` 探测（同一个 pod 里、同一段代码）：

| 分片 | store 来源 | updatedAt | 探测结果 |
|---|---|---|---|
| runner-serving | hostPath `/data/llm-providers.json` | 2026-10-19 | **HTTP 200** |
| runner-c | Secret `agent-runner-llm`（覆盖同路径） | 2026-09-30 | **HTTP 401 `INVALID_API_KEY`** |

两把 key 长度同为 30、指纹不同（`b1f9ec37f8d0` vs `c4256b62a7c2`）；两边模型名册**完全一致**
（同一组 8 个模型），差异只在 key 本身。旧快照自带的 `discovery` 里
`deepseek-v4.1-flash` 已标 `unauthorized`——它就是 parking 的判据来源。

**这解释了「钥匙实测 live 却报 key-invalid」的矛盾**：我先前探的是**部署时那六把 `sk-` 面板钥匙**
（`/api/packs/internal/deployments` 侧，确实 live），而计费闸探的是 **provider store 里那把
provider 级 key**，两把是不同实体。这个歧义是本节最重要的教训。

### 10.2 修复

1. 以 runner-serving 的现行 store 为基座（有效 key + 有效 discovery），
   把 Secret 的 `finddata` provider 整块替换——名册不缩水，旧 discovery 不迁移（防误判）。
2. `kubectl apply` 更新 Secret（该 Secret **不在 GitOps 里**，全仓无 `kind: Secret` 定义，
   Argo 只引用不管理，`selfHeal` 不会回滚它）。
3. `rollout restart deployment/agent-runner-c` → 新 pod 内复探 **HTTP 200**。
4. 两席重新 `serving`（intro-wire :8903 / intro-lex :8915），registry `health_status=healthy`。

### 10.3 真机验收（访客通道，非脚本桩）

用真实访客令牌进房铸席（`mem_bd881b8578257e9779`），`@` 点名提问：

| 席位 | seq | 答复要点 |
|---|---|---|
| 识律专家 | 78 | LawBench 合同智能、法律语料库、微调法律模型；未编造具体 SLA |
| 柏讯专家 | 80 | 「让 AI 替你读世界」：Python 数据源统一为开放数据本体，MCP 数据服务 |

**四席全部可用**：产品向导 / 壹座专家（runner-serving）+ 识律专家 / 柏讯专家（runner-c）。

### 10.4 配额欠账的真实性质（更正 §9.3）

§9.3 判断「内存不够」，**只对了一半，且不是主因**。实际卡住 fd-info 的是 **CPU**：

```
exceeded quota: requested: limits.cpu=1, used: limits.cpu=22800m, limited: 23
```

fd-info 四条 `*/5` CronJob（cn-gov / cninfo / sse-interaction / ship-spool）**同 tick 齐发**，
每条 `limits.cpu=1`、`limits.memory=512Mi`，需要 4 核 + 2Gi 的瞬时头寸。而 `limits.cpu`
实占 22800m/23000m——**只剩 200m**，整批 FailedCreate，重试 3 次后 gap 内偶有抢到者成功，
于是呈「间歇成功/间歇失败」。

**这是既有缺陷**：上一版我只动了 `limits.memory`，没碰 CPU。runner-c 的 500m 只是把
本来就贴顶的 CPU 推到临界（22300m → 22800m）。归因不能算我头上，但也没解决。

事实依据：全集群 Ready 节点 **48 核 / 46.4 Gi 可分配**，真实用量仅 **CPU 2.3 核 / 内存 28.6 Gi**。
配额是人为天花板，与物理容量差一个数量级。

### 10.5 配额调整（GitOps `12b4cf1`，已推 Gitee）

```yaml
limits.cpu: "28"     # 23 → 28（留 5 核头寸给 fd-info 四源同 tick）
limits.memory: 36Gi  # 32Gi → 36Gi（32480Mi 实占，512Mi 作业原本放不进）
```

验证：手工 `create job --from=cronjob/fd-info-fetch-cn-gov` → **1/1 Complete**（31s）；
配额终态 `hard cpu=28 mem=36Gi`，占 `cpu=22800m mem=32480Mi`。

### 10.6 教训入册

1. **「钥匙 live」必须先问是哪个实体**：部署面板钥匙 ≠ provider store 的 provider 级 key。
   两者都叫「钥匙」，报错都叫 key-invalid，却是不同存储、不同轮换节奏。
2. **Secret 覆盖 hostPath 是隐形的版本钉**：挂载把运行态冻结在 Secret 的创建时点，
   而 hostPath 上那份可能已被后续更新（serving 就是这样 10-19 的）。
   判分片配置差异，先比 `updatedAt` 与 key 指纹，别只比 env 键名。
3. **配额卡顿看事件原文里的资源项**：`requested:` 后面写的是哪一项，就是哪一项卡住；
   `limits.cpu` 与 `limits.memory` 是**两个独立闸**，修一个不等于修好。

---

## 十一、永忆回链已上产（2026-10-31 验证通过）

姊妹单 `docs/yongyi-site-zhiyu-link-resupply-20261030.md` 由对侧执行完毕，现网实测：

| 换版单验收项 | 期望 | 实测 |
|---|---|---|
| 首页 HTTP | 200 | **200** |
| `zhiyu.finddatatech.cloud` 计数 | 2 | **2** |
| 「团队如何交谈」 | 1 | **1** |
| 「会话会结束」零回归 | 1 | **1** |
| 「永忆」零回归 | ≥5 | **5** |
| 回链目标 zhiyu 可达 | 200 | **200** |

现网指纹 `c72d83702bbf8b46f6088b955f01485d35645b574f2f2afb67fd2f54b9be4495`（12,024 B），
与换版单 §二、与 `fd-memory` master 的 `site/index.html` **三者一致**。
`Last-Modified: 2026-10-30 21:50:13 GMT`。

链接位置也对得上，不是文本巧合：导航第 29 行（`起跑 | 智语 | GitHub` 之间）、
页脚第 244 行（`evidence report · 智语 · 团队如何交谈`）。

**双向互链闭合**：永忆 → 智语 2 处，智语 → 永忆 3 处，两端域名均 200，无死链。

## 十二、双站工程终态

- **智语官网**：三件静态文件在产，指纹与分支 `site-zhiyu/` 逐字节一致
  （`index.html fd6d1afe…` / `script.js 503c3339…` / `style.css a5645bfb…`）。
- **真房间**：`zy_42ce690574b5423bd2`，**四席全部可用**
  —— 产品向导 / 壹座专家（runner-serving）+ 识律专家 / 柏讯专家（runner-c）。
  访客通道真机实答，识律 `seq=78`、柏讯 `seq=80`，内容有实质、未编造。
- **永忆回链**：在产，双向互链闭合（§十一）。
- **配额**：`limits.cpu 28` / `limits.memory 36Gi`（GitOps `12b4cf1`），
  `fd-info` 四条 `*/5` CronJob 不再被拒。

### 12.1 三条工程教训（本工程新增）

1. **「钥匙 live」必须先问是哪个实体**：部署面板的 `sk-` 钥匙 ≠ provider store 的
   provider 级 key，两者报错都叫 `key-invalid`，却是不同存储、不同轮换节奏。
2. **Secret 覆盖 hostPath 是隐形的版本钉**：挂载把运行态冻结在 Secret 创建时点，
   而 hostPath 上那份可能已被更新。判分片配置差异先比 `updatedAt` 与 key 指纹。
3. **配额卡顿看事件原文的 `requested:`**：`limits.cpu` 与 `limits.memory` 是两个独立闸，
   修一个不等于修好；「内存不够」这个直觉判断在本工程里就错了半次。

### 12.2 一条方法教训

**「某张表里没有某行」≠「对象残缺」**（见 §8.3）。判部署完整度要看
`pack_deployments` 的行数与结构，更要看**服务是否真的应答**——
后者才是对外事实，前者只是账面。这条让一条本该关掉的「待 admin」待办
多挂了一天。
