# evidence — restructure-yizuo-ia（上产实证）

> 取证时间 2026-11-08 15:2xZ（本地 23:2x）。取证机：本地 macOS + `cheap1` / `cheap3`（SSH）。
> 结论：**本次 IA 改动已随 `sha-d7c89b2` 上线，活体逐项命中。** 但 rollout 的 **pod 级状态未取到**（无 fd-prod 集群通道，见 §5）。

## 1. 线完整性（第一闸）

四个提交都在 gitee `release/cell-session-persona` 上，且是远端 tip 的祖先（远端此后又前进了别人的提交）：

```
1d1628ca7  feat(web): 壹座信息架构收口——6 顶层/4 家族、市场合并、设置 12 节
06c042b31  feat(web): 收掉重复的外站市场门——市场是内部的，只有构建出门
0418e648e  chore(i18n): 清掉随外站市场门一起退场的死词条
1fad074e3  fix(lint): 发布线 lint 闸红——9 处机械修，出片前清障
```

复核：`git merge-base --is-ancestor <sha> gitee/release/cell-session-persona` → 四个全 OK（远端 tip 已到 `2fd5e4ec4`）。

## 2. 出片（第二闸：镜像身份）

出片通道 `scs001/platform-image-verify`（公开仓线，免费），run `42493189088` → `Push image` 成功：

```
tag      law-bench/platform:sha-d7c89b2
digest   sha256:0e4e80a4c3633edcd45f143d5588e70a402ef13adf516a2e86413e676b1e46d2
snapshot base  b83a71871613d351846d47c3467511240737d7a9   (gitee/release/cell-session-persona)
builtAt  2026-11-08T15:07:02.778Z
```

`b83a7187` ⊇ 上面四个提交（逐个 `merge-base --is-ancestor` OK）。

ccr 侧硬门（`cheap3` + `/etc/tcr-relay/env`）：

```
skopeo inspect docker://ccr.ccs.tencentyun.com/law-bench/platform:sha-d7c89b2
  OK digest=sha256:0e4e80a4c363 created=2026-11-08T15:09:56
skopeo inspect …:main → 同 digest（relay 同时搬了 main）
```

镜像自证（在 `cheap3` 上跑该镜像）：

```
nav-families-toggle-all   1     ← 全部折叠/展开
agent-market-tab-         1     ← 市场双 tab
agent-market-open         0     ← 外站市场门已删
settings-section-pairing  1     ← 配对与绑定（合并）
```

## 3. 滚产与对账（第三闸）

- 部署清单：`fd-infra-deploy` `284f1e9 chore(platform): roll sha-d7c89b2`，**已推 gitee/main**（`git branch -r --contains 284f1e9` → `gitee/main`）。即 Argo 的真源已指向该片。
- 线上 ≡ 镜像（同一份构建产物）：
  - 活体 `http://100.64.0.14:3100/`（cheap-1 Caddy 反代的后端）主 bundle = `/assets/index-CcLCYn3g.js`
  - 镜像内 `ls /app/web/dist/assets/ | grep '^index-.*\.js$'` → 含 `index-CcLCYn3g.js`
- 活体 bundle 标记（实抓，非推断）：

  | 标记 | 命中 |
  |---|---|
  | `nav-families-toggle-all` | 1 |
  | `nav-shortcut-` / `nav-family-` | 1 / 1 |
  | `settings-section-pairing` | 2 |
  | `settings-search` | 1 |
  | `nav.tuning` / `nav.channels` | 1 / 1 |
  | 市场 chunk `AgentMarketPage-Bwr1hDNS.js`：`agent-market-tab-`=1、`agent-market-studio`=1、`agent-market-open`=0 | — |

- 路由活体探活（未登录，SPA 全返 200 属正常，重定向在客户端）：
  `/`、`/channels`、`/tuning`、`/packs`、`/settings/channels` → 200。

## 4. 过程中的两次阻断（记录，非遗留）

1. **首次出片被 lint 闸拦**（run `42488717222`）：7 个错全在他人文件（`gateway/packs.js` 的两处 `??=`、`services/ops-console` 缺 radix、若干测试的未用变量/空字符类 `[^]`）。已修 9 处并推 `1fad074e3`；相关 6 个测试文件本地 25/25 绿；biome 1697 文件 0 error。
2. **第二次出片被并发会话覆盖**：另一会话强推同一镜像仓（base `b83a7187`），我的 run `42490214288` 被 cancel。因其 base 已含我全部提交，**不重复抢车道**，改为对其实证。

## 5. 未取到的证据（诚实边界）

- **pod 级 rollout 状态未取**：本机 `~/.kube/config` 的 cheap / xinru / tencent 上下文端点全部 `connection refused`；SSH 可达 `cheap1` / `cheap3` / `fd-deploy`，`fd-deploy` 上无 `platform` 命名空间。因此「线上跑的是这片」由**产物同一性**证明，而非 `kubectl rollout status` / pod image 字段。
- 灰度→全量的时间线同样未取（无集群读面）。若需补齐：给一条能连 fd-prod 的 kubeconfig/跳板，补 `kubectl -n platform get pods -o wide` 与 `rollout status` 两段即可。
