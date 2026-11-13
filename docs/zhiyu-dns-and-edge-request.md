# 需求单：`zhiyu.finddatatech.cloud` DNS 与边缘接入

> 交给：能操作 **DNSPod 控制台** 与 **雷池（SafeLine）/本机 Caddy** 的 agent 或运维。
> 出单：2026-10-30（paas 私有仓）。姊妹文档：`docs/zhiyu-site-deploy-requirements.md`（完整部署规范）、
> `docs/yongyi-site-deploy-requirements.md`（同机在先样板，本文大量沿用其已验证惯例）。
> **本文档自足**：不需要读别的文档就能执行完；需要额外资料的地方都写明了取法。

---

## 0. 先读这一节：DNS 其实已经配好了

**出单前已实测（2026-10-30，权威 NS 直查）**：

```bash
$ dig @francis.dnspod.net zhiyu.finddatatech.cloud A +noall +answer
zhiyu.finddatatech.cloud. 600	IN	A	103.236.89.212
```

- 记录**存在**，类型 `A`，值 `103.236.89.212`，TTL `600`，与已上线的 `yongyi` / `memory` / `wanxing` **逐字段同形**。
- `finddatatech.cloud` 无泛解析（随机子域查不到），证明这是一条**独立手工记录**，不是通配符兜出来的。
- 权威 NS 仍是 `francis.dnspod.net` / `zara.dnspod.net`，未被改动。

**所以本单的实际工作量不在 DNS，而在「证书 + 边缘站点」这两步。** 如果你只被授权改 DNS，
那这一步**已经完成，不需要做任何事**——请直接在 §7 的验收里逐条打勾后回报，并把剩余两步转给有边缘权限的人。

---

## 1. 当前故障的精确定位（实测证据）

```bash
# ① DNS 正常，解析到雷池边缘
$ dig +short zhiyu.finddatatech.cloud
103.236.89.212

# ② HTTP :80 有进程应答，但不是「跳 HTTPS」，而是直接 404
$ curl -sS -D- -o /dev/null http://zhiyu.finddatatech.cloud/
HTTP/1.1 404 Not Found
Content-Type: text/html;charset=utf-8        ← 雷池 tengine 的应答形态

# ③ 对照：已上线的 yongyi 在 :80 是 308 跳 HTTPS
$ curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' http://yongyi.finddatatech.cloud/
308 -> https://yongyi.finddatatech.cloud/

# ④ HTTPS 握手失败，原因是边缘回落到旧证书
$ curl -sS https://zhiyu.finddatatech.cloud/
curl: (60) SSL: no alternative certificate subject name matches target host name 'zhiyu.finddatatech.cloud'
$ openssl s_client -connect 103.236.89.212:443 -servername zhiyu.finddatatech.cloud </dev/null 2>/dev/null \
    | openssl x509 -noout -subject -ext subjectAltName
subject=CN=file.finddatatech.cloud                        ← 回落到 file 组的证书
    DNS:bastion..., DNS:file..., DNS:mcp..., DNS:token...  ← 不含 zhiyu
```

**结论**：边缘没有 `zhiyu` 这个站点，SNI 落到默认证书池（`file.finddatatech.cloud` 那张），
所以 `:80` 404、`:443` 证书不匹配。同时，现有在产证书（`CN=paas-admin.finddatatech.cloud`，
13 个 SAN，见 §3.2 全文）**也不含 `zhiyu`**。

---

## 2. 要做什么（三步，按顺序）

| 步 | 动作 | 是否需要 DNS 权限 | 是否需要边缘权限 |
|---|---|---|---|
| A | 确认 DNS 记录（已完成，只需核验） | 是（只读即可） | 否 |
| B | **让 `zhiyu` 进入 TLS 证书** | 否 | 是 |
| C | **建边缘站点 + 本机 Caddy 块 + 放静态文件** | 否 | 是 |

A 已闭环；B、C 是本单的实际工作。

---

## 3. 步骤 B：证书

### 3.1 目标形态（照抄既有成功样板）

```bash
# 期望结果：用 zhiyu 的 SNI 握手，拿到的证书里明确含 zhiyu.finddatatech.cloud
$ echo | openssl s_client -connect 103.236.89.212:443 -servername zhiyu.finddatatech.cloud 2>/dev/null \
    | openssl x509 -noout -ext subjectAltName | grep -c zhiyu
1        # 出单时为 0
```

### 3.2 现有在产证书（共享多域名的那张，CA = Let's Encrypt）

```
subject = CN=paas-admin.finddatatech.cloud
issuer  = C=US, O=Let's Encrypt, CN=YE1
notBefore = Oct 27 21:27:42 2026 GMT
notAfter  = Jan 25 21:26:41 2027 GMT   ← 2027-01-25 到期，续期时顺带加 zhiyu 也可
SAN =
  baiye, connector, desk, juchuang, lex, marketing, memory,
  paas-admin, shilun, wanxing, wire, yongyi, zhesi  (.finddatatech.cloud)
```

**推荐做法（二选一，按贵侧既有流程走，不要另创第三条路）**：

- **B1（首选，最小改动）**：把 `zhiyu.finddatatech.cloud` **加进这张共享证书的 SAN** 并重签。
  优点：与 `yongyi`/`wanxing` 等 13 个域共用一张，浏览器链一致、到期日一致。
- **B2**：给 `zhiyu` 单独签一张。功能上等价，但多一张证书要单独续期，除非贵侧流程本来就是按域签。

**注意**：
- `finddatatech.cloud` 的 `CAA` 记录为空（已查），**没有**限定 CA，Let's Encrypt 可正常签发。
- `_acme-challenge.finddatatech.cloud` 无 TXT/CNAME 委派（已查）——说明现网不是走「DNS 委派验证」，
  而是走 **HTTP-01** 或 **acme.sh 的 DNS API 直写**。**沿用现网既有那条路即可**，不要为了这个域新引入验证方式。
- 若选 HTTP-01：80 端口必须能对 `/.well-known/acme-challenge/` 返回 200。当前 `:80` 对本域返回 404 且
  未建站点——**这正是 HTTP-01 现在会失败的原因**，所以 B 与 C 有顺序耦合，见 §5 的两种执行序。

### 3.3 顺带确认（不要动的东西）

```bash
dig +short MX finddatatech.cloud      # 5 mxbiz1.qq.com / 10 mxbiz2.qq.com —— 企业邮箱，绝对不动
dig +short A  finddatatech.cloud      # 124.220.7.175 —— 主站，不动
dig +short NS finddatatech.cloud      # francis/zara.dnspod.net —— 不动
```

---

## 4. 步骤 C：边缘站点 + 静态站

### 4.1 要放的三个文件（**只有三个**）

```bash
tar -tzf zhiyu-deploy-20261030.tar.gz
index.html
style.css
script.js
```

- 包 sha256：`f3f41e073f5f05969ada1104143f48e6a5890667cc77866ca46a1e7f2cd46e37`
- 取包途径见 §6。**解包后必须核对三个文件齐全，且目录里不要多放任何东西**
  （设计记录、PRODUCT.md、内部文档都**不得**放进静态目录，它们含内部信息）。

```bash
mkdir -p /srv/zhiyu-site
tar -xzf zhiyu-deploy-20261030.tar.gz -C /srv/zhiyu-site
ls -l /srv/zhiyu-site      # 期望恰好 3 个文件
```

### 4.2 本机 Caddy 站点块（与 `yongyi` 同模式）

```
zhiyu.finddatatech.cloud {
  root * /srv/zhiyu-site
  encode gzip
  file_server
  header /index.html Cache-Control "no-cache"
  header /*.css Cache-Control "public, max-age=604800"
  header /*.js  Cache-Control "public, max-age=604800"
  header {
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
  }
}
```

- 单页站点，无路由；深链回落 `index.html` 即可（可选 `try_files {path} /index.html`）。
- 无后端、无反向代理、无流式参数——**这是纯静态站，不要给它挂任何 API 反代**。
- 唯一外部依赖是 Google Fonts（`fonts.googleapis.com`，失败自动回落本机宋体/等宽），**无需代理或镜像**。

### 4.3 雷池控制台

- 为本域**新建 site**，来源指本机 Caddy 对应块（与 `platform`/`mcp`/`wanxing`/`yongyi` 同模式）。
- 开启 **HTTP → HTTPS 301/308**（现在 `:80` 是 404，上线后应与 `yongyi` 一致：308 跳 HTTPS）。
- WAF 用默认强度；静态站不需要放宽 body 规则。

### 4.4 页面会外链到的目标域（若贵侧对出站做策略，需放行）

| 目标 | 用途 |
|---|---|
| `https://wanxing.finddatatech.cloud/` | 主 CTA「去万星开一间房」、顶栏、页脚 |
| `https://yongyi.finddatatech.cloud/` | 姊妹站互链 |
| `https://wanxing.finddatatech.cloud/zhiyu/widget.js` | 活演示区；**当前 `data-room` 为空，不会加载**，无需预先放行 |

---

## 5. 执行顺序（B 与 C 的顺序耦合）

**序一（推荐，若贵侧走 HTTP-01）**：先 C 的「建站 + 静态文件 + Caddy 块」让 80 端口对本域有应答，
再跑 B 的证书签/续，最后 reload。这样 HTTP-01 校验能拿到 200。

**序二（若贵侧走 DNS API 直写）**：B、C 无先后，先 B 后 C 或并行都行。

**无论哪种序，最后都要**：

```bash
caddy validate --config /etc/caddy/Caddyfile && caddy reload --config /etc/caddy/Caddyfile
```

---

## 6. 取包途径（重要，别用 raw）

**不要用 `raw.githubusercontent.com`**：雷池机与 cheap1 实测被 SSL 重置，拉不下来。

**源已推送，以下命令可直接执行**（分支 `deliver/zhiyu-official-site`，仓库 `FindDataTechnology/fd-craw-private`，需读权限）：

```bash
# 整包取（codeload；不要 raw，雷池机实测 raw 会被 SSL 重置）
BRANCH=deliver/zhiyu-official-site
curl -L -o /tmp/paas.tar.gz \
  "https://codeload.github.com/FindDataTechnology/fd-craw-private/tar.gz/refs/heads/$BRANCH"

# 只解出站点三个文件到 /srv/zhiyu-site
mkdir -p /srv/zhiyu-site
tar -xzf /tmp/paas.tar.gz -C /tmp --strip-components=1 \
    --wildcards '*/site-zhiyu/*'
cp /tmp/site-zhiyu/index.html /tmp/site-zhiyu/style.css /tmp/site-zhiyu/script.js /srv/zhiyu-site/
```

**取到后必须核对（三个哈希都对上才算完整）**：

```
index.html  76a46cf65f758421edcce08be36b646aeb7176a1a7ecc7f77607dd10feb2afcb
style.css   a5645bfb3fe5f8d9aefae2d65cd360291fc0e11a6ea3449fb3fd208aeaf4d066
script.js   262005955856b257de2acbd1cb43c4123f53887e7e350044efafb4fff3be47d3
```

```bash
cd /srv/zhiyu-site && sha256sum index.html style.css script.js
```

> **若仓库侧无读权限（私有仓匿名访问返回 404）**：改走自包含交付件
> `zhiyu-site-source-bundle.md`——三个文件的完整源码 + 哈希都在那一份里，不依赖任何账号权限；
> 或把上面三条哈希发回，由我方另走带外通道送 tar
> （tar 自身 sha256 = `f3f41e073f5f05969ada1104143f48e6a5890667cc77866ca46a1e7f2cd46e37`）。
> **不要**从 `raw.githubusercontent.com` 取（已知被 SSL 重置）。

---

## 7. 验收（逐条跑，全部通过才算完成）

```bash
# ① DNS（应已通过）
dig @francis.dnspod.net zhiyu.finddatatech.cloud A +noall +answer
#   期望：zhiyu.finddatatech.cloud. 600 IN A 103.236.89.212

# ② HTTPS 证书含本域（本单核心判据）
echo | openssl s_client -connect 103.236.89.212:443 -servername zhiyu.finddatatech.cloud 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName | grep -c zhiyu
#   期望：1（出单时为 0）

# ③ 证书校验通过 + 200
curl -sS -o /dev/null -w 'code=%{http_code} ssl=%{ssl_verify_result}\n' https://zhiyu.finddatatech.cloud/
#   期望：code=200 ssl=0

# ④ 80 跳 HTTPS（与 yongyi 一致）
curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' http://zhiyu.finddatatech.cloud/
#   期望：308（或 301）-> https://zhiyu.finddatatech.cloud/

# ⑤ 内容在位
curl -s https://zhiyu.finddatatech.cloud/ > /tmp/z.html
grep -c '智语 · Zhiyu' /tmp/z.html      # 期望 ≥1
grep -c '让智能体团队' /tmp/z.html       # 期望 ≥1

# ⑥ 泄漏门（任一非 0 即视为未通过，请立刻回报）
grep -c '壹座' /tmp/z.html                                    # 期望 0
grep -cE 'yizuo\.local|10\.43\.|NodePort|31899|sub2api|spider-heal' /tmp/z.html   # 期望 0

# ⑦ 合成标注未丢（诚实性条款）
grep -c '合成' /tmp/z.html              # 期望 ≥1

# ⑧ 静态资源与缓存头
curl -sI https://zhiyu.finddatatech.cloud/style.css | grep -iE '^HTTP|cache-control'
#   期望：200 + public, max-age=604800
```

**视觉抽查（人工 30 秒）**：桌面打开首屏应见一张圆桌 + 「让智能体团队，和人类同桌说话。」+ 两个按钮；
向下滚动时圆桌应依次转向（分身席 → 访客席 → 门口 → 桌心）。手机宽度下应顺排、不横向滚动。

---

## 8. 回滚

```bash
# 站侧：还原旧文件（若首次上线则直接删除目录）
rm -rf /srv/zhiyu-site && caddy reload --config /etc/caddy/Caddyfile

# 边缘侧：删掉雷池对应 site
# 证书侧：若已把 zhiyu 加进 SAN 并重签，无需回滚（多一个 SAN 无害）
# DNS 侧：本单不动 DNS；若确需摘除，删该 A 记录，TTL 600s 内收敛
```

**独立可回滚**：删 site + reload 即回到「本域无站点」的原状，不影响同机其他任何域。

---

## 9. 报告格式（回单请按此写，便于比对）

```
[状态] 完成 / 部分完成 / 阻塞
[A DNS]      记录值 + TTL + 是否改动
[B 证书]     选 B1 还是 B2；新证书 subject / issuer / notAfter / SAN 是否含 zhiyu
[C 站点]     文件目录、Caddy 块位置、雷池 site id、80 跳转状态
[验收]       §7 ①–⑧ 逐条贴实际输出
[偏离]       与本文档不一致之处及原因（没有就写「无」）
[阻塞]       需要谁提供什么（没有就写「无」）
```

---

## 10. 边界（不要做的事）

- **不要**改 `finddatatech.cloud` 的 NS / MX / apex A 记录，也不要新建泛解析。
- **不要**动其他域的 Caddy 块或雷池 site；本单只新增 `zhiyu` 一个域。
- **不要**给这个站加任何动态接口或反向代理——它是三个静态文件。
- **不要**把 `docs/zhiyu-site-design.md`、`PRODUCT.md`、`.impeccable/` 下的任何文件放进静态目录。
- **不要**把 `data-room` 填成任何带写权限的凭据（widget 令牌只需防猜测长度，公开可见是设计如此）。
- 需要改 DNS 时**只读确认，不要重建记录**：删了再加会有一段解析空窗（TTL 600s）。
