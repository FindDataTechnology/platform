# 智语官网 · 换版单（真房间上线）

> 2026-10-30 第二班。首版三文件已在产（`deliver/zhiyu-official-site` @ `051f5211`）。
> **本次只换两个文件**，`style.css` 逐字节未变，请勿覆盖（覆盖无害但徒增校验量）。
> 换版内容：演示章由「合成演示」升级为**真房间内嵌 iframe**，房间与令牌已在生产建好并端到端验过。

## 一、换什么

| 文件 | 新 SHA-256 | 字节 | 旧（在产）SHA 前 12 |
|---|---|---|---|
| `site-zhiyu/index.html` | `fd6d1afece1173b0c24aae50c4263019237bc9f057eb532085b757c4a0758706` | 15,774 | `76a46cf65f75…` |
| `site-zhiyu/script.js` | `503c3339247c09a9dfe75473dd05110359651e9419426f27d2b2ae692722f703` | 7,610 | `262005955856…` |
| `site-zhiyu/style.css` | **不变** `a5645bfb3fe5f8d9aefae2d65cd360291fc0e11a6ea3449fb3fd208aeaf4d066` | 12,708 | 同（无需动） |

变化面（只有这两处，其余逐字节相同）：

1. `index.html` 演示章：房主段文案改成事实口径（在席两席=「产品向导」「壹座专家」；本轮只放一席开口；车道故障如实报错），
   并把 `data-room=""` 填成真实房间令牌。
2. `script.js` 活演示挂载：由「浮标 widget.js」改为「`/zhiyu/embed/<token>` 内嵌 iframe」（`.room-shell iframe` 样式在首版里就有，无需新 CSS）。

## 二、取件（只用 codeload，raw.githubusercontent 被边缘 SSL 重置）

```bash
# 交付分支（GitHub 主 / Gitee 备）
curl -L -o zhiyu-site.tar.gz \
  https://github.com/shichengsi/paas/raw-placeholder  # 见下：私有仓匿名 codeload 会 404，必须带凭据
```

私有仓匿名取件一律 404，两条正路任选：

```bash
# A. 带凭据 codeload（token 走环境变量，勿写进命令行历史）
git clone --depth 1 -b deliver/zhiyu-official-site \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/shichengsi/paas.git" /tmp/zhiyu-site \
  && cd /tmp/zhiyu-site && git log --oneline -1
```

**交付分支 tip = `b0ac658fc64196b304098d351ce417b0ffef46a9`**（GitHub 与 Gitee 同名分支同一 sha，已核）。
按分支名取件即可，无需 sha。零凭据路线：

```
docs/zhiyu-site-source-bundle.md   # 三文件全文内联 + 逐文件 sha256，可直接重建
```

## 三、落位（雷池后面那台 Caddy 的静态目录，路径同首版）

```bash
cd <静态目录>/zhiyu
shasum -a 256 style.css   # 必须是 a5645bfb3fe5…（先证明你手里是那一版）
cp /tmp/zhiyu-site/site-zhiyu/index.html .
cp /tmp/zhiyu-site/site-zhiyu/script.js .
```

## 四、验收（四条，全过才算换完）

```bash
# 1) 内容指纹对上
curl -s https://zhiyu.finddatatech.cloud/script.js | shasum -a 256
curl -s https://zhiyu.finddatatech.cloud/index.html | shasum -a 256

# 2) 令牌已挂进演示章
curl -s https://zhiyu.finddatatech.cloud/index.html | grep -c 'data-room="wtr_'

# 3) 合成演示痕迹只留在无令牌兜底路径（页面上仍应有，属正常兜底）
curl -s https://zhiyu.finddatatech.cloud/index.html | grep -c 'syn-note'

# 4) 内部名词零泄漏（应为 0）
curl -s https://zhiyu.finddatatech.cloud/index.html https://zhiyu.finddatatech.cloud/script.js \
  | grep -icE '壹座·Packs|cell|fleet|k8s|NodePort|10\.43\.|100\.64\.|103\.236\.|sub2api|cheap-[0-9]'
```

浏览器侧（无痕窗口，未登录）：滚到最后一章 → 约一秒内出现真聊天窗（浅色产品窗，带深色描边），
顶部一行「你是访客身份，由 zhiyu@finddatatech.cloud 的值守分身接待」，输入框能发出去，
「产品向导」会作答；另一席被「本轮席位已满员作答，其余席位保持静默」收住——这是设计行为，不是故障。

## 五、回滚

`index.html` / `script.js` 任一件换坏，直接用首版三件整体替换（`051f5211` 那版，
或 `docs/zhiyu-site-supply-order-20261030.md` 里记录的三枚 sha），房间与令牌不受影响（在平台侧，不在静态目录）。

## 六、边界（这次不要顺手做的事）

- 不要改 `style.css`（未变），不要新增文件、不要传 `docs/` 任何一份（含本单）。
- 静态目录里**永远不要出现** `PRODUCT.md`、`.impeccable/`、`openspec/`、`.zcode/`。
- 令牌是公开设计的一部分（访客凭它进房），但它**只读**：不含任何可写凭据；`siteSecret` 不在这三件里，也不该出现。
- 域名白名单只放了 `zhiyu.finddatatech.cloud` 与提供源 `platform.finddatatech.cloud`
  （后者是 iframe 自身同源请求的 referer 落点，不放则访客铸席 403——真机验过）。
