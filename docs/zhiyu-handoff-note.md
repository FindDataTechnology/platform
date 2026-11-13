# 转交说明：智语官网（zhiyu.finddatatech.cloud）

> 可直接整段转发给对方 agent / 运维。本文档是**转发稿**，不含内部细节。

## 一、上次为什么没找到

两个原因，都成立：

1. **我方没有提交推送**——站点文件此前只存在于本地工作树。这是我的疏漏，现已补齐。
2. **仓库是私有的**——`FindDataTechnology/fd-craw-private` 未授权访问时返回 404（页面显示「不存在」），
   所以即便当时推了，你那边也看不到。

## 二、现在有三条路，按你手上的权限选一条

### 路 A：你有该私有仓读权限（最快）

已推送：分支 `deliver/zhiyu-official-site`，HEAD commit `a2e88d6387be`。

**私有仓必须带凭据**——匿名请求一律 404（实测；公开仓才会 200）。二选一：

```bash
# A1 用 git 克隆（SSH key 已配好时最省事）
git clone --depth 1 -b deliver/zhiyu-official-site \
  git@github.com:FindDataTechnology/fd-craw-private.git /tmp/zhiyu-src

# A2 用 token 走 codeload（用 commit sha，不用分支名——分支名含 / 会被 URL 当路径分隔符）
curl -L -H "Authorization: token $GITHUB_TOKEN" -o /tmp/paas.tar.gz \
  "https://codeload.github.com/FindDataTechnology/fd-craw-private/tar.gz/a2e88d6387be"

mkdir -p /srv/zhiyu-site
tar -xzf /tmp/paas.tar.gz -C /tmp --strip-components=1 --wildcards '*/site-zhiyu/*'
cp /tmp/site-zhiyu/index.html /tmp/site-zhiyu/style.css /tmp/site-zhiyu/script.js /srv/zhiyu-site/
```

> 仍然 404 就是没有读权限（或 token 过期），**改走路 B**，不要反复试。

### 路 B：你没有仓库权限（最稳，不依赖任何账号）

我方随附一份**自包含源码交付件**：`zhiyu-site-source-bundle.md`。
里面是三个文件的完整源码 + 逐文件 sha256，**单文件即可重建站点**，不需要仓库、网络或账号。
请向我方索取该文件，按文中第二节存成三个文件即可。

### 路 C：带外通道

向我要 tar（`zhiyu-deploy-20261030.tar.gz`，12,652 B，
sha256 `f3f41e073f5f05969ada1104143f48e6a5890667cc77866ca46a1e7f2cd46e37`）。

## 三、取到文件后必须核对（三个哈希全对才算完整）

```
index.html  76a46cf65f758421edcce08be36b646aeb7176a1a7ecc7f77607dd10feb2afcb   15,626 B
style.css   a5645bfb3fe5f8d9aefae2d65cd360291fc0e11a6ea3449fb3fd208aeaf4d066   12,708 B
script.js   262005955856b257de2acbd1cb43c4123f53887e7e350044efafb4fff3be47d3    7,271 B
```

```bash
cd /srv/zhiyu-site && sha256sum index.html style.css script.js
```

**静态目录里只放这三个文件**，不要多放任何东西。

## 四、DNS 不用你做（重要）

实测（2026-10-30，权威 NS 直查）：

```
zhiyu.finddatatech.cloud. 600  IN  A  103.236.89.212
```

记录已存在、类型/TTL/指向与已上线的 `yongyi`/`memory`/`wanxing` 完全同形，且无泛解析。
**不要重建这条记录**（删了再加会有 600 秒解析空窗）。

## 五、真正要处理的是这两件

| 项 | 现状（实测） | 目标 |
|---|---|---|
| HTTPS 证书 | 回落 `CN=file.finddatatech.cloud`，SAN 不含 zhiyu → `curl: (60)` 主机名不匹配 | 证书 SAN 含 `zhiyu.finddatatech.cloud` |
| 边缘站点 | `:80` 返回 **404**（与 yongyi 的 308 跳转不同） | 建站 + 80→443 跳转 + 200 |

现有在产共享证书：`CN=paas-admin.finddatatech.cloud`，13 个 SAN，Let's Encrypt，
`notAfter = 2027-01-25`。**推荐把 zhiyu 加进这张的 SAN 并重签**（与其余域一致），或单独签一张，按贵侧既有流程即可。
`CAA` 为空（无限制），`_acme-challenge` 无委派（说明现网不是 DNS 验证，沿用原路径）。

**顺序注意**：若走 HTTP-01，必须先建站让 80 端口对本域有应答，否则校验拿 404。

## 六、站点技术形态（便于你判断风险）

- 纯静态三文件，**无构建、无后端、无反向代理、无路由**。
- 唯一外部依赖：Google Fonts（`fonts.googleapis.com`），失败自动回落本机宋体/等宽，**无需代理或镜像**。
- 只有三个出站链接：`wanxing.finddatatech.cloud`、`yongyi.finddatatech.cloud`，
  以及一个**当前不会加载**的 `wanxing.../zhiyu/widget.js`（`data-room` 为空）。
- 无 cookie、无分析脚本、无第三方跟踪。

## 七、验收（六条，全过才算完成）

```bash
# 1 证书含本域（核心判据，现在是 0）
echo | openssl s_client -connect 103.236.89.212:443 -servername zhiyu.finddatatech.cloud 2>/dev/null \
  | openssl x509 -noout -ext subjectAltName | grep -c zhiyu        # 期望 ≥1

# 2 HTTPS 正常
curl -sS -o /dev/null -w '%{http_code} ssl=%{ssl_verify_result}\n' https://zhiyu.finddatatech.cloud/
#   期望：200 ssl=0

# 3 80 跳 HTTPS
curl -sS -o /dev/null -w '%{http_code} -> %{redirect_url}\n' http://zhiyu.finddatatech.cloud/
#   期望：308/301 -> https://zhiyu.finddatatech.cloud/

# 4 内容在位
curl -s https://zhiyu.finddatatech.cloud/ | grep -c '让智能体团队'    # 期望 ≥1

# 5 三个文件均可取
for f in style.css script.js; do curl -s -o /dev/null -w "$f %{http_code}\n" \
  "https://zhiyu.finddatatech.cloud/$f"; done                       # 期望均 200

# 6 缓存头
curl -sI https://zhiyu.finddatatech.cloud/style.css | grep -i cache-control
#   期望：public, max-age=604800
```

人工 30 秒：桌面打开应见一张圆桌 + 「让智能体团队，和人类同桌说话。」+ 两个按钮；
向下滚动圆桌依次转向（分身席 → 访客席 → 门口 → 桌心）。手机宽度下顺排、不横向滚动。

## 八、回滚

```bash
rm -rf /srv/zhiyu-site && caddy reload --config /etc/caddy/Caddyfile
# 再删雷池对应 site。证书加了 SAN 无需回滚。DNS 不要动。
```

## 九、回单格式

```
[状态] 完成 / 部分完成 / 阻塞
[取件] 走路 A/B/C 哪条；三文件 sha256 是否全部对上
[证书] 走的共享证书加 SAN 还是新签；新证书 subject / notAfter / SAN 是否含 zhiyu
[站点] 目录、Caddy 块位置、雷池 site id、80 跳转状态
[验收] 上述六条逐条贴实际输出
[阻塞] 需要谁提供什么（没有写「无」）
```
