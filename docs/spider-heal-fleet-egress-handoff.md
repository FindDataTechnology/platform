# spider-heal 执行体：fleet 出口与技能传播 —— 萬星侧配合事项

> 来源：finddata 侧 2026-10-12 凭据轮换与链路体检
> 对象：萬星（paas）侧
> 状态：**P0 / P1 已收口上线并实证（2026-10-12 晚）**；
> **P2 已全部收口（2026-10-13 上线实证：单行引号 + 单行取值 93 字符全值）。**
> ⚠️ **2026-10-13 补记：P0 存在漏面——b/c 补丁未覆盖 serving 车道**，
> 接管波后 spider-heal 落 runner-serving（cheap-4）无出口，工单连卡 7 轮；
> finddata 侧已修（`fd-infra-deploy` `31083c3`，详见「P0 漏面」节）。
> 更新记录见文末「收口状态」。

## 背景（一段话）

2026-10-12 我们处理了一起 agent 自报的 `git_pat` 脱敏事故：两次 Regenerate + v9/v10 重部署，
新值 `ws_a6f56…7zNX` 已 pin 到执行体并端到端验证通过。处置过程中发现**两个萬星侧的结构性问题**，
其中一个会直接阻断修复链处理真工单。以下是证据、影响与建议修法。

---

## P0 · runner-b / runner-c 无 GitHub 出口（阻断真工单）

### 现象（实证）

spider-heal 的 v9/v10 部署被 **fleet 自动选址**落到了 `runner-b` / `runner-c`：

```
$ kubectl -n fd-prod exec agent-runner-c -c runner -- curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://github.com
000        # TCP 超时

$ kubectl -n fd-prod exec agent-runner-c -c runner -- python3 -c 'import socket; socket.create_connection(("github.com",443),timeout=6)'
TimeoutError
```

- `runner-b`（cheap-6，tailnet `100.64.0.13`）与 `runner-c`（cheap-7，`100.64.0.14`）**均连不上 GitHub**。
- 对照：`cheap-1` 主机 `curl https://github.com` → **200**；`cheap-1` 的 `agent-runner-dsh` 容器内同样 200。
- DNS 正常（`github.com → 20.205.243.166`），**是 TCP 层不通**，非解析问题。

### 影响

spider-heal 的修复/生成流程必须读 GitHub（浅检出工单与目标单元、推分支、开 PR）。
落在无出口的 runner 上时，**真工单会卡在取件/推送环节**。
（注：当前技能走 GitHub **API + tarball** 而非系统 git——镜像历版不含 git，这不是本次回归——
但 API 同样需要 GitHub 出口，所以出口是硬需求。）

### 修法（已实测有效，建议照抄 fd-health-runner 先例）

**推荐：给两个 runner 注入代理环境变量**。cheap 节点侧已有现成的 mihomo 出口中继，
且 `fd-health-runner`（同一 cheap 集群）就是这么解决的——复用同一个 secret 即可：

```yaml
# fd-infra-deploy/all-services/prod/agent-runner-b.yaml（runner-c 同法）
    spec:
      containers:
        - name: runner
          envFrom:
            - secretRef:
                name: agent-runner-b-env
            - secretRef:
                name: fd-health-proxy        # ← 新增这一行
```

`fd-health-proxy` 的键（已存在，无需新建）：`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`，
值形如 `http://<user>:<pass>@100.64.0.7:30081`，`NO_PROXY` 含
`localhost,127.0.0.1,100.64.0.0/10,10.42.0.0/16,10.0.0.0/8,.finddatatech.cloud,.tencentyun.com`。

**已在 runner-b pod 内实测**（临时导出同一 secret 的值后）：

```
https://github.com               -> 200
https://api.github.com           -> 200
https://platform.finddatatech.cloud -> 200   # NO_PROXY 生效，未绕远
```

同时确认 **runner-b 能连通 mihomo 中继**（`100.64.0.7:30081` TCP OK）与 cheap-1 runner
（`100.64.0.11:8790` TCP OK）——即网络路径本身是通的，只差 env 注入。

**备选（若不愿给全部 agent 走代理）**：把 spider-heal 固定调度到 cheap-1。
部署接口支持显式指定：

```bash
# 现有脚本尚未透出 runnerId；可直接对部署接口带参（body 增加 runnerId）
POST /api/packs/KkCie7NlrHluo4LiKPnn0w/versions/<v>/deploy
{ "runnerId": "cheap-1", "secrets": { "spider-heal": { "git_pat": "…" } } }
```

（`gateway/packs.js` 部署路由：`runnerIdBody` 命中 fleet 表即显式选址，未命中返 400 并列出合法 id。
当前 fleet 表三行：`cheap-1` / `runner-b` / `runner-c`。）
我们也可以给 `scripts/spider-heal-pack.mjs` 加一个 `RUNNER_ID` env 透出——**需要萬星侧确认走哪条路**，
若走这条我们可以直接提 PR。

> ⚠️ 注意自动选址逻辑（`gateway/fleet-scheduler.js` `pickPlacement`）按
> **内存余量最大、children 最少**排序，**不看 GitHub 出口**——所以只要 b/c 无出口，
> 后续每次部署都可能再被调度过去。修出口（推荐）比固定调度更稳。

---

## P1 · 技能正文传播断链（我们已热修，需萬星侧永久化）

### 现象（实证）

registry 里 spider-heal 四个技能条目的取值源是**陈旧的**：

```
$ mongosh mcp_registry --eval 'db.agent_skills_default.findOne({name:"spider-heal-repair"})'
  skill_md_content = null
  skill_md_raw_url = https://craw.finddatatech.cloud/api/packs/KkCie7NlrHluo4LiKPnn0w/versions/1/skills/spider-heal-repair.md
                                                                    ^^^^^^^^^^^^^^^^ 冻在 10-03 创建时的 v1
  skill_md_url     = https://facet.finddatatech.cloud/api/packs/…/versions/9/skills/spider-heal-repair.md
```

- 内容端点（`skill_routes.py` `get_skill_content`）逻辑：`skill.skill_md_content` 为空 →
  回退到 `skill.skill_md_raw_url or skill.skill_md_url`。
- 而 `skill_md_raw_url` 是**创建时（10-03，pack v1）写入后再没更新过**，
  于是**子机冷启动永远拉到 v1 的旧技能文本**——我们 v9/v10 里写的技能加固根本没到执行体。
- 这正是同一起泄露事故里 agent 重复犯错的原因：它读到的仍是 v1 版「单行 grep+sed 读凭据」的旧指令。

### 为什么部署没带上新正文

`SkillRegistrationRequest`（`registry/schemas/skill_models.py`）**没有 `skill_md_content` 字段**：

```
request fields: [… 'skill_md_url', 'repository_url', 'version', 'id', …]
skill_md_content in request? False
skill_md_raw_url in request? False
```

而部署侧（`lib/agent-serving.js` `deployToRegistry`）**明明 PUT 了 `skill_md_content` 与
`skill_md_url`**（每技能 upsert，含当前版本号），但：
- `skill_md_content` 被请求模型丢弃（不在 schema）；
- `skill_md_raw_url` 从未被设置（不在 schema），首次创建时由 registry 从 `skill_md_url`
  翻译一次（`translate_skill_url`，非 GitHub URL 原样保留）→ 之后**永不更新**。

### 我们已做的热修（临时）

直接写库把当前版本正文与 raw_url 补上（`mcp_gateway_registry-registry-1` 容器内
`/app/.venv/bin/python` + pymongo，`agent_skills_default`）：

```python
col.update_one({"name": n}, {"$set": {
  "skill_md_content": <当前版本正文>,
  "skill_md_raw_url": f"https://facet.finddatatech.cloud/api/packs/{pack}/versions/10/skills/{n}.md",
}})
```

已验证子机拿到新文本（`cred()` 在场、旧 sed 消失）。**但这只是补数据，不改链路——
下次 pack 升级正文仍不会自动传播。**

### 建议的永久修法（二选一）

1. **schema 增字段（推荐）**：`SkillRegistrationRequest` 加 `skill_md_content: str | None`
   （与 `SkillCard` 已有的同名字段对齐），PUT 时落库；这样部署侧现有代码即刻生效，
   正文随版本走。
2. **raw_url 随版本刷新**：在 `deployToRegistry` 的技能 upsert 里同时 PUT
   `skill_md_raw_url`（当前版本 URL）；需 schema 同步放行该字段。此法保留「按 URL 拉取」
   语义，但多一次外网取件。

> 无论选哪条，**建议同时把 `skill_md_url` 与 `skill_md_raw_url` 一起随版本更新**，
> 避免再出现「展示的是 v9、实际取的是 v1」的错位。

---

## ✅ 收口状态（2026-10-12 晚更新）

### P0 · 已收口并实证（finddata 侧 2026-10-12 复测）

```
agent-runner-b: api.github=200 | platform=200
agent-runner-c: api.github=200 | platform=200
```

两台 runner 现已能访问 GitHub（`api.github.com` 200，此前 TCP 超时）；内网
`platform.finddatatech.cloud` 仍 200，说明 `NO_PROXY` 生效、未被代理绕远。
**P0 闭合**——spider-heal 落在这两台时，取件/推送链路可用。

（对照：交接文档写就时两台均为 `000`/TCP 超时；补丁方案当时只在 runner-b pod 内
以临时导出 env 的方式验证有效，现已落到实际部署。）

### ⚠️ P0 漏面 · runner-serving 未注入代理（2026-10-13 发现，finddata 侧已修）

**b/c 的补丁漏了 serving 车道**。同日（10-12）接管波把 spider-heal 从 cheap-1 的
`agent-runner-dsh` 挪到了 `runner-serving`（cheap-4，`add-serving-runner-split`），
而 serving 清单的注释假设「serving children 与旧容器同为直连出网」——**该假设被证伪**：
旧容器在 cheap-1（主机有直连 GitHub），cheap-4 与 cheap-6/7 同无直连路由。

实证（10-13 上午）：

```
$ kubectl -n fd-prod exec agent-runner-serving-6b7889df58-kssss -c runner -- \
    curl -s -o /dev/null -w "%{http_code}" --max-time 8 https://api.github.com
000          # 无代理、无直连
$ # 同 pod 临时导出 fd-health-proxy 值后
api.github.com=200 | github.com=200 | platform=200（NO_PROXY 生效）
```

agent 自报同样吻合：`inbox.json` / 投递回执自 **10-12T22:31Z 起连续 7 轮**报
「GitHub egress 阻断」，10-13 三张工单（flower-auction / inmetals / metal-com）
全部卡 `state=queued`。

**finddata 侧已修**（`fd-infra-deploy` `31083c3`，双远端已推，ArgoCD 自动滚）：
serving 清单 `envFrom` 增加 `secretRef: fd-health-proxy`，与 b/c、fd-health-runner 同款。

**修复实证（2026-10-13 11:41Z）**：

```
# 新 pod（agent-runner-serving-76596d75db-7c26k）实测
api.github.com=200  github.com=200  codeload.github.com=301   # 三次复测稳定
child pid 44 环境已继承 HTTPS_PROXY/HTTP_PROXY/NO_PROXY（与 secret 值一致：len=37）
# 20 次连续采样：ok=19 / fail=1（~5% 抖动，见下）
```

**端到端实证（11:38Z 节奏回合）**：agent 取队首单
`20261013-flower-auction-67f0aee9` → 五类分诊=兜底类（证据不足）→ 终态 `manual`，
未推分支/未开 PR（符合「不猜不修」纪律）；队列 3→2。**修复前该单连卡 7 轮**。

> ⚠️ **残余抖动（新观察点）**：代理链路 ~5% 请求超时（20 次采样 1 次 000），
> agent 回合恰好撞上时会在回执里报「出口抖动/TIMEOUT」。修复前是 100% 失败、
> 修复后是偶发——但**代理质量本身值得萬星侧核**（mihomo `100.64.0.7:30081` 上游
> 稳定性/多出口轮换）。建议 agent 侧对读类请求加一次重试以吸收此抖动。

> 教训：**出口是节点属性，不是 deployment 属性**。每次 runner 迁移/新增车道都要
> 对照本清单核出口——fleet-scheduler 的 `pickPlacement` 不看出口，迁移即可能落进盲区。

### 🔸 观察点 · agent 调 MCP `health_config_get` 得 402 CALLER_NOT_MAPPED（2026-10-13）

serving 上 spider-heal child 的 `gate-state.json`（01:29Z 回合）显示：

```json
{"mcp": {"tool": "health_config_get", "http_status": 402, "error": "CALLER_NOT_MAPPED",
         "note": "调用者未完成计费开户映射（端点可达，调用者未映射）"}}
```

端点可达、鉴权通过，但**调用者身份未完成计费开户映射**——agent 因此拿不到中央库
阈值配置（本轮回退到文件基线，又因 GitHub 阻断连文件也读不到）。请萬星侧核：
spider-heal 调用 `health_config_get` 所用凭据（哪把 key / 哪个 caller 身份）是否
应在计费侧补开户映射。此项不阻断修复主链（阈值可走文件基线），但影响
`health-threshold-calibration` 的中央库回填消费。

### P1 · 已收口（change `fix-skill-content-propagation`，12/12 归档）

- 规格：新 capability **`skill-content-propagation`** 已 sync 入主 specs（129/129），
  三条要求：内联正文随版本更新 / 未带正文的编辑不清空存量 / `raw_url` 随
  `skill_md_url` 派生刷新（并维持「未改展示 URL 不动取值 URL」）。
- 生产实证（最关键一条）：在 wanxing-facade pod 内用 `AGENT_SERVING_REGISTRY_TOKEN`
  ——即**部署侧 go 的同款鉴权**——注册一次性技能 201 → PUT 带内联正文 200 且卡片回显
  → `GET .../content` 200 `source:inline` 直取到探针正文 → DELETE 204 清场。
- 发布过程的一条重要更正：原 design D4 打算「cherry-pick 切 fd-1.1.2」，但其前提
  （生产是 fd-1.1.1、那三笔提交未发布）**已被证伪**——生产实为 fd-1.2.1（`sha-c9a2015`），
  三笔提交早已并列进 origin/main（PR #4/#5）。若按过期基点打包，会把 virtual-router
  作用域修复与 fastembed 瘦身一起倒退。实际做法=rebase 到真 origin/main（`ad118d4a`）
  后发 patch **fd-1.2.2**。

### 剩余自然验收点 —— ✅ 已完成（2026-10-12，spider-heal v11）

修复的**真传播**已在 spider-heal 升 **v11** 时实证，mongosh 三查全中：

```
--- spider-heal-repair（本次唯一改动项）
  正文: 2331 → 2437（含 v11 新增标记）      ✅ 正文 = 新版本
  raw_url: .../versions/11/skills/...        ✅ 指 v11
  content_updated_at: 2026-10-12T15:45:52Z  ✅ 滚动
--- 其余三条（protocol/notify/generate）
  raw_url 全部 v10 → v11；content_updated_at 同步滚动 ✅
```

对比：v10 那次是 finddata **手工补库**（正文长度不变、raw_url 靠硬写）；
v11 是**部署链路自动传播**——P1 根治确认生效，此后无需再手工补数据。

### P2 · 已全部收口（2026-10-13 上线实证）

**第一项（凭据块标量改单行）——已上线并生产实证**：
根因是 `js-yaml` 默认把长密钥折成块标量（`git_pat: >-`），技能单行 grep/sed 取到空串
→ agent 打印原文 → 完整值落会话日志。修法=写 `.credentials.yaml` 时统一
`yaml.dump(doc, { lineWidth: -1, forceQuotes: true })`——**两条写入路径都改了**
（`compose.js` 两处写入点 + `dsh-profile.js` `ensureCredentialsStore`；两条路径写同一份文件，
格式必须一致，否则「值带不带引号」取决于谁最后写）。

**上线（2026-10-13）**：镜像 sha-5c9f532（真 sha 5f9c37d）经 `scs001/platform-image-verify`
出片 → relay → ccr；**三处服务面全部滚齐**——平台应用、k8s runner-b/c、以及 cheap-1 手工容器
`agent-runner-dsh`（**它才是 spider-heal child 凭据的真正写入者**）。

**生产实证**（cheap-1，spider-heal 真实 child）：触发一次真 A2A 回合令 child 重生后：

```
$ docker exec agent-runner-dsh cat /data/packs-KkCie…-spider-heal/.credentials.yaml
  git_pat: '<github_pat_…7zNX>'        # ← 单行引号，无块标量
$ # 单行取值法（事故当时的失败模式）
value_len: 93   suffix: …7zNX   no_block_scalar: True   # 值完整、单行、无块标量（此处不引用全文）
```

三台 runner 全扫零块标量；并清理了 k8s runner-b/c 上 spider-heal 的 v9/v10 孤儿凭据文件
（旧格式副本，不会被读但属散落凭据）。回归测试：`agent-runner/test/credentials-scalar.test.mjs`
（3 例）+ `scripts/test-credential-file-format.mjs`（6 例，含 93 字符 PAT 与单行取值等价）。

**第二项（代理凭据对 agent 可见）——已落地并实证**：
child 进程环境实测已继承 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
（mihomo `100.64.0.7:30081`），这正是 P0 复测 `api.github=200` 的原因。本项闭合。

---

## 验证清单（供萬星侧自证）

修完后按此清单验收（命令均可直接跑）：

```bash
# 1) 出口
kubectl -n fd-prod exec deploy/agent-runner-b -c runner -- \
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://api.github.com     # 期望 200
kubectl -n fd-prod exec deploy/agent-runner-c -c runner -- \
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://api.github.com     # 期望 200

# 2) 内网不被代理绕远（NO_PROXY 生效）
kubectl -n fd-prod exec deploy/agent-runner-b -c runner -- \
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 10 https://platform.finddatatech.cloud  # 期望 200

# 3) 技能正文随版本（P1 修完后：升级 pack 到新版本，再查 registry）
#    skill_md_content 非空 且 与当前版本一致；skill_md_raw_url 指向当前版本
```

---

## 附：本次轮换的完整事实（存档）

- 泄露：agent 自报（脱敏命令对块标量失效）；落点=会话轨迹文件，已删；finddata 仓内零命中。
- 轮换：两次 Regenerate + v9/v10 重部署；在用 `git_pat ws_a6f56…7zNX`；
  每次窄授权复验（身份 FindDataOfficial / 目标仓写 201 / 非目标仓 403 / 私有仓 404）。
- 取证：runner 会话存档为 **zstd 多帧**（单帧解码只得骨架），逐帧拼接扫描后新值 0 命中。
- 镜像无 git：**历版皆无，非本次回归**；技能走 API+tarball（会话实证 ghApi/tarball 引用）。
- 我们侧的记录：`docs/spider-heal-pack.md` 末节（④ git PAT 权限范围）。
