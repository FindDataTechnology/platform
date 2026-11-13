# 交接文档 — 谦面双案（polish-facet-usability + add-facet-copilot）出片收尾

> 生成于 2026-10-24（Opus 5 会话中断处）。接手环境：Mac，`/Users/chengsishi/paas`。
> 读 `paas-release` skill 后按本文走；本文与 skill 不一致时以 skill 为准。

## 一、任务一句话

两个 OpenSpec change 的代码**已全部提交并在 main**，出片进行到一半：镜像 `sha-f8f1505` 已含全部代码、platform 已滚产，**facet.yaml 还停在旧 tag 待滚**；之后做真机验收、pack v3 发布、勾任务、归档。

## 二、已完成（勿重做）

### 代码（全部已提交 main，均过测试）

| commit | 内容 |
|---|---|
| `814b5ecf` | polish-facet-usability 11/13：字号收敛（灭 26 处 text-[9/10/11]px）、五语键化（facetCurate/facetMine 41 键 + common.retry）、三态骨架（壳面+Store 面）、IntroView 路径图图形化、globals.css 动效+CJK 回退、facet/web/DESIGN.md |
| `a954a003` | add-facet-copilot 6/9：CopilotDock 路由推导 `/agents?tab=market` → line=facet；pack 上下文只读注入（`web/src/lib/copilot-pack-context.ts` + postMessage + embed 上下文条）；无助手降级提示条；谦面助手 pack v3 manifest（六技能） |
| `205d7369` | lint 修：PackMarketView effect 依赖按 detailId 键控（biome useExhaustiveDependencies） |

验证已绿：facet/web build、web build、check-locales 5 语 parity、test-palette-contrast 4/4、copilot-presets 10/10、official-packs lint 6/6、e2e 45/45（copilot-dock 7 / action-card-turn 4 / agents-tabs 6 / facet-shell 8 / packs 20）。

决策记忆已落 ai-memory：`facet-copilot-implementation-status.md`、`facet-polish-copilot-changes.md`。

### 出片（判路已完成）

- `fd-build-channel` 判路 = **公开仓免费线**（`scs001/platform-image-verify`，tier1）。
- **关键事实：并行会话在我提交之后落了 `2b8cc9a9`（凭据续期），其快照 `f8f1505` 已包含本双案全部提交**（`git merge-base --is-ancestor 205d7369 2b8cc9a9` 实证）。并行会话已出片 f8f1505 并滚产 platform：台账提交 `27ac7d99` 记录 digest `e1e6daa1`，`all-services/prod/platform.yaml:54` 已是 `sha-f8f1505`。
- **facet.yaml（`all-services/prod/facet.yaml:66`）仍是旧 tag `sha-055a236`** —— 这是本双案「壳面改动上生产」的缺口。

## 三、剩余步骤（按序）

### 1. 核实 f8f1505 在 ccr 可见（bump 前硬门）

```bash
gh run list -R scs001/platform-image-verify --limit 3        # 确认 f8f1505 的 image run 绿
ssh cheap3 'grep "yizuo/platform:sha-f8f1505" /var/log/tcr-relay.log'
ssh cheap3 'source /etc/tcr-relay/env && skopeo inspect --creds "$TCR_USER:$TCR_PASS" docker://ccr.ccs.tencentyun.com/yizuo/platform:sha-f8f1505' | head -5
```

没看到 OK 行就先 `/usr/local/bin/tcr-relay-sync.sh` 补单（撞 flock 等 `RUN DONE`）。**tag 不在 ccr 不许 bump（停机事故前科）。**

### 2. 滚 facet.yaml

```bash
cd ~/finddata/fd-infra-deploy && git pull      # 并行会话在推，必先 pull
# 编辑 all-services/prod/facet.yaml:66
#   image: ccr.ccs.tencentyun.com/yizuo/platform:sha-f8f1505
#   注释写明：谦面双案（polish-facet-usability + add-facet-copilot，paas 814b5ecf/a954a003/205d7369，含于快照 f8f1505）
git add all-services/prod/facet.yaml && git commit -m "[skip ci] facet 滚 tag f8f1505：谦面双案（polish+copilot）" && git push gitee main   # 必须推 gitee
kubectl --context cheap -n argocd annotate application all-services-prod argocd.argoproj.io/refresh=hard --overwrite
kubectl --context cheap -n fd-prod rollout status deploy/facet
```

### 3. in-pod 实证（双案各自的标记）

```bash
# 壳面改动在位：路径图图形化后的新 i18n 键
kubectl --context cheap -n fd-prod exec deploy/facet -- sh -c 'grep -rl "pathGraph" /app/web/dist/assets | head -2'
# Store 面改动在位：copilot pack 上下文模块
kubectl --context cheap -n fd-prod exec deploy/platform -- sh -c 'grep -rl "copilot_pack" /app/web/dist/assets | head -2'
# digest 同一性
kubectl --context cheap -n fd-prod get deploy facet -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

再浏览器验收（真机，账号见 ai-memory `生产走查账号凭据`）：
- `https://facet.finddatatech.cloud/#/` 路径图=三节点图形；`#/mine`、`#/curate` 无中英混排、骨架正常、切英文看键化（右上语言切换）；
- 壹座 `/agents?tab=market`：右下副驾 FAB → 打开应带「谦面助手」聚焦（前提：该 cell 已装助手 pack——**若未装**会看到琥珀降级提示条，这也是预期态）；
- polish 2.4/3.3 的四态走查（浅/暗/移动宽/reduced-motion × 五视图 × 两面）顺手做完，勾任务。

### 4. 谦面助手 pack v3 发布（add-facet-copilot 4.1，狗粮）

```bash
cd docs/official-packs
facet validate facet-assistant-manifest.json
facet publish facet-assistant-manifest.json --from https://facet.finddatatech.cloud --new-name "谦面助手"
```

前置：当前账号在 `creators` 组、facet CLI 已配对。发布后 3.2 真机四问（概念/推荐/权限解释/安装引导——在壹座 market tab 副驾里实测各一轮）。

### 5. 收尾

- 勾任务：polish 2.4/3.3/4.2、copilot 3.2/4.1/4.2（`openspec/changes/<name>/tasks.md`）
- 回归确认不倒退后归档：`openspec archive polish-facet-usability`、`openspec archive add-facet-copilot`（先 sync specs）
- 台账补记一节（照 `27ac7d99` 风格：paas sha → 快照 sha → digest → GitOps → 实证）

## 四、坑位（本轮已知）

- **镜像仓 CI 红≠出片被挡**：`scs001/platform-image-verify` 的 `ci.yml`（lint→unit→e2e）现红 12 个 biome 错，全是 fleets 系旧账（`scripts/test-fleet-*`、`server/fleet-*`、`FleetGraph/FleetsPage`，别会话的），`image.yml` 出片门不含 lint/unit，**不挡出片**；该 lint 债不归本双案清。
- **e2e 本地跑前先 `npm run web:build:e2e`**：跑过普通 `web:build`（无 seam）后 copilot/action-card 族会假红「Cannot read setState」。
- **主仓 push 状态未核**：本地 main 领先远程与否未确认，出片不依赖它，但收尾前 `git log origin/main..HEAD` 看一眼，有就双推（origin + gitee）。
- **工作区有并行会话在途文件**（`gateway/packs.js`、`e2e/live-agents.spec.js` 删除、logs/trace.db）：**勿 `git add -A`**，提交只点自己文件（前科：并行会话卷走改动）。
- **Recreate 策略**：facet 滚动有秒级中断；滚完 settle 30s 再公网验。
- relay 长尾 15-25 分钟常态，别 5 分钟就慌。

## 五、两 change 工件位置

- `openspec/changes/polish-facet-usability/`（proposal/design/tasks/specs，11/13）
- `openspec/changes/add-facet-copilot/`（6/9）
- 设计真源：`facet/web/DESIGN.md`
- pack v3：`docs/official-packs/facet-assistant-manifest.json`（notes 已写 v3 说明）
