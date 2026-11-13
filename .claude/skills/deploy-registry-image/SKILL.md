---
name: deploy-registry-image
description: Use when building, releasing, rolling out, verifying, or rolling back the MCP registry (谦面, mcp.finddatatech.cloud) image — any task touching mcp-gateway-registry's release pipeline, TCR image flow (GHA→hkccr→cheap-3 relay→ccr), cheap-1 compose cutover, or registry version bumps (fd-x.y.z). **出片前先跑 `fd-build-channel` 判路**（公开仓=免费无限 / 私有池=2000 分钟每月每账号；含额度与成本陷阱）。Also covers diagnosing why a build run went red (quota vs real defect), relay backfill, embeddings/ONNX weight placement, and the full verification evidence chain.
metadata:
  version: 1.0.0
---

# registry 镜像发布运行手册

沉淀自 slim-registry-image（fd-1.2.0，2026-10-11）全链实录。目标：按此走，不再踩坑。

## 0. 环境事实（先记牢）

| 项 | 值 |
|---|---|
| fork 仓 | `/Users/chengsishi/code/mcp-gateway-registry`（remotes: origin=github org / gitee / scs001 / upstream） |
| **生产栈** | **cheap-8 k8s**（`kubectl --context cheap -n mcp-registry`：deploy `registry`/`auth-server`/`mcpgw`/`mongodb`，hostNetwork）。**2026-10-25 双宿主更正**：公网 mcp.finddatatech.cloud → Caddy → 100.64.0.15:18080 = cheap-8；cheap-1 compose 栈（`/opt/mcp-gateway-registry/`）**已退役、无公网流量**——别再对它取证/修复（2026-10-25 §15.36 教训：同名容器，ssh 可达，误入歧途半天） |
| GitOps | `~/finddata/fd-infra-deploy/mcp-registry/prod/`（registry.yaml/auth-server.yaml/mongodb.yaml/mcpgw.yaml/landing-config.yaml）+ `argocd/app-mcp-registry.yaml`；registry 镜像按 **digest 钉**（防 IfNotPresent 吃缓存），注释写真 sha |
| 镜像仓库 | `hkccr.ccs.tencentyun.com/yizuo/{mcp-registry,mcp-auth-server}`（构建推此）→ relay → `ccr.ccs.tencentyun.com/yizuo/...`（部署拉此） |
| relay | cheap-3 `（ssh 别名 cheap3）` `/usr/local/bin/tcr-relay-sync.sh`，cron */5，清单 `/etc/tcr-relay/repos.conf`，日志 `/var/log/tcr-relay.log` |
| Mongo | k8s pod `mongodb`（hostNetwork=node IP），**凭据在 registry pod env**（`DOCUMENTDB_USERNAME/PASSWORD`，kubectl exec printenv 取；mongo pod 自身无该 env）；库名 `mcp_registry`，语义向量集合 `mcp_embeddings_384_default`（集合名内嵌维度） |
| 版本号 | 外建 Secret `mcp-registry-env` 的 `BUILD_VERSION`（`kubectl patch secret` + `rollout restart`），镜像 ENV 不改 |
| 台账 | paas `docs/registry-maintenance.md`（§1 运行表 + §9 起发布记录 + §15.x 发布/事故实录） |
| ssh 别名全集 | `cheap1` / `cheap3` / `fd-deploy`（无 cheap-1/cheap-3 写法，写错=莫名 Connection closed）。**cheap-8 无 ssh 别名也不需要**——一切 kubectl 直达 |

## 1. 管线决策树（构建走哪条线）

**先跑一条命令，不要人工调查、不要读 run 注解试错：**

```bash
fd-build-channel          # 现状 + 现在用哪条 + 各账号额度余额 + 成本陷阱（吃 24h 缓存）
fd-build-channel pick mcp-gateway-registry
```

> **2026-10-14 更正（旧版此处的"账单阻断绕行梯"已被证伪）**：run 里那句
> "recent account payments have failed…" **不是欠费**，是该账号**私有仓免费额度
> 2000 分钟/月用尽**（实测 FDT = 2011/2000，10-07 触顶）。而且**公开仓标准 runner
> 免费无限、不受同账号私有额度耗尽影响** → 成本最低的线其实是公开仓，不是绕道换账号。
> 旧的三级梯（org → scs001 → law-ai-official）不再作为判据；判路一律看 `fd-build-channel`。

```
代码已合入 origin/main？
├─ fd-build-channel         # 唯一判路入口：给出现在该用哪条 + 各池余额
├─ T1 公开仓线（免费无限，首选）：
│    · 仓库公开且有 image.yml → push main 直接触发
│    · 私有源码 → 公开快照仓（如 scs001/platform-image-verify，免费无限）
│    · registry 的正统公开线：FindDataTechnology/mcp-gateway-registry 是 private，
│      故走快照仓或下面的通用池
├─ T2 通用构建池（私有线，各账号独立 2000 min/月）：
│    fd-build-snapshot <源码仓URL> -R <org>/build-pool --namespace yizuo --image mcp-registry
│    现役池：testaction001..005/build-pool（~10,300 分钟）；fd-build-channel 会推荐余额最多的
└─ 全不通才手工建（最后手段）
```

- **失败先看失败 step**：跑到业务步才红 = 真缺陷或 flaky，`gh run view --log-failed` 确认，
  别默认 flaky、也别当额度问题。已知 flaky 仅 dsh 合同 ⑨（多会话并发）。
- **不要用 cheap-3 本地 docker build**（慢且坑多：apt/PyPI 直连爬行、注入镜像源时 sed 表达式的 `|` 必须加单引号否则被容器 shell 当管道吃掉、apt 源在基础镜像 `/etc/apt/sources.list.d/` 里不在 Dockerfile 文本里）。仅作 GHA 全线瘫痪时的最后手段。
- **镜像 sha tag 是 7 位短 sha**（metadata-action 默认），不是 8 位。查 tag 少一位 = 假阴性，先怀疑自己数错。
- BUILD_VERSION 在 image.yml 里手改（版本纪律：部署可见变化=minor，修复=patch；不引入自动推导）。
- image.yml 对 mcp-registry 有**预算门**：体积 ≤1600MB + 容器内 `import fastembed` 成功 + `import torch` 必须失败。job 绿 = 门已过；体积数字在 log 里 grep `image size:`。

## 2. relay 回灌（hkccr → ccr 广州）

```bash
# 自动循环每 5 分钟；确认清单里有所需仓库
ssh cheap3 'grep mcp-registry /etc/tcr-relay/repos.conf'
# 不等循环，手动补一单（tag 用 7 位）
ssh cheap3 '/usr/local/bin/tcr-relay-sync.sh yizuo/mcp-registry sha-XXXXXXX'
# 日志确认
ssh cheap3 'grep sha-XXXXXXX /var/log/tcr-relay.log | tail -1'   # 期望 "OK yizuo/mcp-registry:sha-XXX"
```

- 循环一轮可能超 5 分钟（tag 多），日志出现 `SKIP: 上次同步仍在运行` 是正常锁竞争，不是故障。
- TCR 个人版有 **tag 总量上限**历史事故：推新 tag 失败而更新旧 tag（如 main）成功 = 撞上限，去控制台删（v2 API 删不回收配额，必须控制台删）。

## 3. 滚版（k8s，GitOps 线）

```bash
# 3.0 换版前检查：当前运行的 digest/tag
kubectl --context cheap -n mcp-registry get deploy registry auth-server -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.template.spec.containers[0].image}{"\n"}{end}'
# ⚠️ 并行会话检查：GitOps 里的 image 若指向一个【未在运行】的新 sha/digest，那是别的会话的待发布，先确认归属。

# 3.1 ccr 硬门（没落地就 bump = 停机事故，mcp-registry ns 同样适用）
ssh cheap3 'source /etc/tcr-relay/env && skopeo inspect --creds "$TCR_USER:$TCR_PASS" docker://ccr.ccs.tencentyun.com/yizuo/mcp-registry:sha-<tag>'

# 3.2 GitOps bump（registry 按 digest 钉，auth-server 按 sha tag 钉；注释写真 sha）
cd ~/finddata/fd-infra-deploy && git pull    # 并行会话也在推，必先 pull
#   编辑 mcp-registry/prod/registry.yaml（或 auth-server.yaml）的 image 行
git add mcp-registry/prod/<file>.yaml && git commit -m "..." && git push gitee main

# 3.3 ArgoCD 对齐滚动（app: mcp-registry，独立于 all-services-prod）
kubectl --context cheap -n argocd annotate application mcp-registry argocd.argoproj.io/refresh=hard --overwrite
kubectl --context cheap -n mcp-registry rollout status deploy/registry --timeout=420s

# 3.4 版本号（fd-x.y.z 语义：minor=可见变化，patch=修复）——外建 Secret，不动镜像
kubectl --context cheap -n mcp-registry patch secret mcp-registry-env -p '{"stringData":{"BUILD_VERSION":"fd-x.y.z"}}'
kubectl --context cheap -n mcp-registry rollout restart deploy/registry
```

- Recreate/滚动窗口内公网有秒级中断，settle 30s 再验。
- cheap-1 compose 栈已退役（无公网流量）——**不要**再去 cheap-1 改 compose；它还在跑只占 100.64.0.11:18080，与公网无关。

## 4. 验证证据链（无鉴权也能全验）

```bash
# 4.1 启动日志：三行全中才算过
kubectl --context cheap -n mcp-registry logs deploy/registry --tail=200 | grep -iE "ONNX embeddings|fastembed model loaded|Failed to load" || echo "(boot logs may have rotated — check startup-era logs)" 
#    期望：ONNX embeddings model found / fastembed model loaded successfully. Dimension: 384 / 无 Failed

# 4.2 健康
kubectl --context cheap -n mcp-registry exec deploy/registry -- curl -sf -m 5 http://127.0.0.1:7860/health

# 4.3 容器内功能实测（embedding 类变更时）
kubectl --context cheap -n mcp-registry exec deploy/registry -- /app/.venv/bin/python -c ""
from pathlib import Path
from registry.embeddings import create_embeddings_client
import numpy as np
c = create_embeddings_client(provider=\"fastembed\", model_name=\"all-MiniLM-L6-v2\",
       model_dir=Path(\"/app/registry/models/all-MiniLM-L6-v2\"), embedding_dimension=384)
v = c.encode([\"中文测试\",\"english test\"]); print(v.shape, float(np.linalg.norm(v[0])))"'
#    期望：(2, 384) 1.0

# 4.4 数据面不动核对（Mongo 向量条数前后一致；凭据在部署树 .env）
# 凭据从 registry pod env 取（mongo pod 自己没有）
PW=$(kubectl --context cheap -n mcp-registry exec deploy/registry -- printenv DOCUMENTDB_PASSWORD)
kubectl --context cheap -n mcp-registry exec deploy/mongodb -- mongosh -u admin -p "$PW" --authenticationDatabase admin --quiet mcp_registry --eval 'print(db.mcp_embeddings_384_default.countDocuments())'

# 4.5 公网
curl -s -o /dev/null -w "%{http_code}\n" https://mcp.finddatatech.cloud/     # 200
curl -s -o /dev/null -w "%{http_code}\n" "https://mcp.finddatatech.cloud/api/v1/servers?limit=1"  # 401（无凭据正确拒）
```

**换 embedding 引擎时追加：向量级等价对比**（换 embedding 引擎时的权威方法）

**日常换版更便宜的一招——仓库层语义抽检**（无鉴权，容器内直接跑，不经过 HTTP 网关）：
写个 .py 经 `kubectl cp` 进 registry pod 再 `kubectl exec ... /app/.venv/bin/python`（**不要 kubectl exec 内联多层引号的 python -c**，转义必崩）：
```
from registry.repositories.factory import get_search_repository
repo = get_search_repository()
r = await repo.search(query="weather", max_results=3)   # 注意：签名是 max_results，不是 limit
# 结果 dict：实体类型 -> 文档列表；名字字段是 server_name / skill_name（不是 name），另有 relevance_score
```
中英混合词各一发，看跨 servers/skills/tools/virtual_servers 是否命中且头名语义合理（fd-1.2.0 实测：weather→eco-mcp-time、法律检索→fd-legal-search-mcp、database query→daas/cell、网页抓取→研究类 workflow）。**这比 admin `/reindex` 更能证明索引可用**——reindex 端点按 paths 重建且要 admin+CSRF，非必需别触发。

（替代需鉴权的 API 查询对比）——切换前在生产旧容器内用旧引擎、本地/新容器用新引擎，对同一组中英混合文本出向量：同文本跨引擎余弦 ≥0.999 且语义邻居 top-3 排序全重合 = 索引免重建实证（fd-1.2.0 实测 0.999999、8/8）。

## 5. 新主机/新模型的权重预置（bind mount 侧）

- ONNX 载荷：`~/mcp-gateway/models/all-MiniLM-L6-v2-onnx/`，五文件（`model.onnx`(90MB, md5 9efe4122ed…) / config.json / tokenizer.json / tokenizer_config.json / special_tokens_map.json）。
- **放兄弟目录 `-onnx`，绝不与 torch 权重混放**——两边 config.json/tokenizer 同名但 md5 不同，混放会互相污染。FastembedClient 探测顺序：本体目录 → `-onnx` 兄弟 → HF 懒下载（尊重 HF_ENDPOINT 镜像）。
- 生成载荷的最快方法：本地 venv `TextEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2", cache_dir=/tmp/fe-cache)` 下载一次，拷 `models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/<hash>/` 下五文件。bare 模型名（不带 `sentence-transformers/` 前缀）会被 fastembed 注册表拒收，客户端内已做归一化。

## 6. 回滚（GitOps revert，无数据迁移）

```bash
cd ~/finddata/fd-infra-deploy
# registry.yaml 的 image 行 revert 到上一个 digest/tag（旧镜像都还在 ccr；节点有缓存秒恢复）
git revert <commit>   # 或手动改回 image 行
git push gitee main
kubectl --context cheap -n argocd annotate application mcp-registry argocd.argoproj.io/refresh=hard --overwrite
kubectl --context cheap -n mcp-registry rollout status deploy/registry --timeout=420s
```

旧权重目录并存互不影响（bind mount 侧语义不变）。

## 7. 本地测试配方（fork 仓）

```bash
cd /Users/chengsishi/code/mcp-gateway-registry
uv sync --frozen --extra dev            # yara-python 无 macOS cp314 wheel 时加 --no-install-package yara-python
# ⚠️ scripts/test.py 裸调 PATH 里的 pytest——必须锚定 venv，否则串到 micromamba 环境（假结果）
PATH="$PWD/.venv/bin:$PATH" .venv/bin/python scripts/test.py unit -n 8
```

- yara-python 4.5.4 全平台无 cp314 wheel：macOS 源码编撞 homebrew OpenSSL 3.5（CFLAGS 补丁无效），本地跳过、CI linux 能编——该缺口由 CI 覆盖，本地失败算环境性。
- mongo 依赖的 integration 测试本地无 mongo 会失败/拖超时（CI 有 mongo service 会真跑）——本地跑 unit + 无 mongo 依赖的 integration 即可，权威绿看 CI。

## 8. 收尾纪律（每次发布必做）

1. 台账 `docs/registry-maintenance.md`：§1 运行表换新 sha+版本说明；追加发布记录（体积对比、构建线、验证证据、待办）。
2. openspec change 勾任务 → `openspec validate --specs` → archive → paas 提交（**只 add 本变更文件**，树上常有其他会话在途 change）。
3. gitee 线同步：仅当无并行会话占用（该线是 wire-onboarding 的在途分叉时，同步归其会话收尾，台账记待办即可）。
4. 用户侧待办明示：admin `/reindex`（embedding 变更的保险重建）+ 浏览器一眼验收。

## 9. 坑速查表（按故障现象反查）

| 现象 | 根因 | 处置 |
|---|---|---|
| GHA run 5~8 秒全红、零 step 执行 | 该账号**私有额度 2000 分钟/月用尽**（**不是欠费**；2026-10-14 实测 FDT=2011/2000） | 跑 `fd-build-channel` 判路：改用有余额的池，或走公开仓免费线（不受影响）。**别把额度问题误判成代码问题** |
| GHA run 红但跑了 ≥10 秒 | 真缺陷或 flaky（**与额度无关**） | `gh run view <id> --log-failed` 看**失败 step**：有业务错误文本=真缺陷（如 2026-10-14 `896e142` 的 `ctx.userQuestions.registerProvider is not a function`）；无业务错误、同 commit 别处绿=⑨ 类 flaky，`rerun --failed` |
| hkccr 查不到刚推的 sha tag | tag 是 **7 位**不是 8 位 | 用 7 位重查 |
| compose up 报 alpine/python 拉取超时 | 没带 `--no-deps`，旁支 init 服务拉 docker.io | `up -d --no-deps <svc>` |
| 本地测试莫名全绿/串环境 | scripts/test.py 走了 PATH 的 micromamba pytest | `PATH=.venv/bin:$PATH` 前缀 |
| 本地 yara 构建失败 OpenSSL 头 | cp314 无 wheel+homebrew OpenSSL 3.5 | `--no-install-package yara-python`，CI 覆盖 |
| relay 日志 SKIP | 上一轮循环还没跑完（tag 多） | 等或手动补单 |
| 推新 tag 失败但 main tag 更新成功 | TCR 个人版 tag 上限 | 控制台删旧 tag（API 删不回收） |
| scp/ssh 莫名 Connection closed | 主机别名写错（cheap-1 ≠ cheap1） | 用 `cheap1`/`cheap3`；cheap-8 无 ssh，全走 kubectl |
| 对 registry「取证/修复」却现象对不上 | **打错了栈**：cheap-1 compose 旧栈还活着（同名容器、独立旧 Mongo），公网流量全在 cheap-8 k8s（2026-10-25 §15.36 教训） | 先 `curl -s http://100.64.0.15:18080/health` 对 worker_id；取证/修复一律 kubectl -n mcp-registry |
| 容器内 python 报 SyntaxError 反斜杠 | ssh 内联多层引号转义崩溃 | 本地写 .py → scp → docker cp → docker exec |
| `search() got unexpected kwarg 'limit'` | 仓库层签名是 `max_results` | 换参数名；结果名字字段是 `server_name`/`skill_name` |
| GitOps 里的 sha/digest 和运行容器不一致 | 并行会话预指了待发布镜像 | §3.0 先查归属再动 |
