# 智语（Zhiyu）官网上线需求文档

> 交付对象：雷池（SafeLine）机器（公网 103.236.89.212）上的运维 AI。
> 姊妹文档：`docs/yongyi-site-deploy-requirements.md`（同一台机、同一套 Caddy/雷池模式，本文沿用其全部惯例）。
> 日期：2026-10-30。状态：待执行。
> 源目录（私有仓 `paas`）：`site-zhiyu/` —— **仅三个文件**：`index.html`、`style.css`、`script.js`。
> 设计记录：`docs/zhiyu-site-design.md`（**不要**发布这个文件）。

## 一、目标与域名

| 域名 | 角色 | 上游 |
|---|---|---|
| `zhiyu.finddatatech.cloud` | **智语官网（纯静态）**，无构建、无动态接口 | 雷池机器本地静态目录（Caddy `file_server`） |

**DNS**：`zhiyu.finddatatech.cloud` A 记录 → `103.236.89.212`（由属主在 DNSPod 添加，TTL 先 600s）。
证书：沿用贵侧既有 Let's Encrypt 流程（DNS 生效后申请）。

## 二、部署任务

1. 静态目录，建议 `/srv/zhiyu-site/`，只放三个文件（`index.html` / `style.css` / `script.js`）。
2. Caddy 站点块（与 `yongyi` 同模式）：

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

3. 雷池控制台为该域建站点（site），来源指本机 Caddy 对应块（与 `platform`/`mcp`/`wanxing`/`yongyi` 同模式）。
4. HTTP → HTTPS 301；单页站点无路由，深链回落 `index.html` 即可。
5. **外部依赖只有一个**：Google Fonts（`fonts.googleapis.com`，Noto Serif SC + IBM Plex Mono）。
   加载失败自动回落本机宋体/等宽，无需代理或镜像。
6. 请求体上限/速率限制：静态站，用默认值即可。
7. WAF：走默认强度。

## 三、页面里的外链（需要放行的目标域）

| 落点 | 用途 |
|---|---|
| `https://wanxing.finddatatech.cloud/` | 主 CTA「去万星开一间房」、顶栏「开一间房」、页脚 |
| `https://yongyi.finddatatech.cloud/` | 姊妹站互链（顶栏、正文、页脚） |
| `https://wanxing.finddatatech.cloud/zhiyu/widget.js` | **活演示**：真房间令牌注入后挂 widget（见 §五） |

若雷池对这些域做内容规则，`widget.js` 与 iframe 需与 wanxing 站同策略（`frame-ancestors` 由平台侧下发，
新域需在房间设置的**域名白名单**里登记 `zhiyu.finddatatech.cloud`——见 §五，这是平台侧动作、不是雷池动作）。

## 四、永忆站同批小改（同一趟补给）

永忆站 `site/index.html` 已加两处对智语的互链（导航「智语」+ 页脚「智语 · 团队如何交谈」）。
**同批上传**这三个文件即可，永忆站其余文件不动：
- `yongyi/index.html`（改动）
- `zhiyu/index.html`、`style.css`、`script.js`（新增）

推荐一次性打包（见 §六），运维侧只做「解包覆盖 + reload」。

## 五、活演示（可选，分两步，任一步不做也不阻塞上线）

页面 `#demo` 区的容器是 `<div class="room-shell" id="liveRoom" data-room="">`。
`data-room` 为空时展示**合成演示**并明确标注「合成演示 · 真房间令牌签发后此区即为活房间」——
**这是诚实的降级态，可以就这样上线**。

要让这一区变成真房间（产品即演示），平台侧三件事：

1. 用普通用户路径建一间「智语值守房」，部署一个值守分身（内部＝范例，无后门）。
2. 在房间设置里开启嵌入：提交域名白名单，加入 `zhiyu.finddatatech.cloud`（可再加 `localhost` 供本地验证）。
3. 取得 widget 令牌（平台存哈希、不存明文），把令牌写进 `index.html` 的 `data-room="<令牌>"`，
   重新上传该文件。

护栏按已验证机制配置：**日预算 + 应答上限 + 熔断**；模型钉 `:free` 车道（内部负载纪律）。
事项串保留开启，让「它答不上会给你留一张转人工字条」这句文案成立。

> 令牌是公开可见的（它在 HTML 里），这与 widget 令牌的设计一致：防猜测靠长度，授权靠域名白名单，
> 吊销靠平台侧一键 休克。**不要把任何其他凭据写进这三个文件。**

## 六、日常改版发布口径（2026-11-10 补记）

站点是**静态文件直接铺在雷池机** `/srv/zhiyu-site/`（Caddy `file_server`），**不随 platform 镜像**。
改了 `site-zhiyu/` 下任何文件，出片/滚版都不会带上它——必须单独发布：

```bash
ssh root@103.236.89.212 'cp /srv/zhiyu-site/<file> /srv/zhiyu-site/<file>.bak-$(date +%F)'
scp site-zhiyu/<file> root@103.236.89.212:/srv/zhiyu-site/<file>
```

两条缓存纪律（踩过）：

- `index.html` 是 `no-cache`，改完立刻生效；
- `style.css` / `script.js` 是 `public, max-age=604800`（7 天）。**改这两个文件必须同时改 `index.html` 里的版本串**
  （`style.css?v=YYYYMMDD`），否则老访客一周内仍跑旧样式，等于没发。

验收仍按 §八。`壹座` 是官方对外产品名（见 §八 订正），文案里出现「壹座产品介绍」「壹座专家」是**正确**的，
不要为过门而删真实席位名。

## 七、补给包（推荐形态）

按 10-29 教训：**raw.githubusercontent.com 在雷池机与 cheap1 会被 SSL 重置**——
补给单一律走 `codeload.github.com` 整包 tar.gz，或随文档附带的 tar 包，不要给 raw 链接。

```bash
# 在打包机上（本仓根目录）
tar -czf zhiyu-deploy-20261030.tar.gz \
    -C site-zhiyu index.html style.css script.js
# 与永忆同批时，再加 yongyi 的 index.html
```

解包到 `/srv/zhiyu-site/` 后 `caddy reload`，再在雷池控制台刷新站点配置。

## 八、验收（三层，与永忆同标准）

1. **源站**（雷池机本地）：`curl -sI http://127.0.0.1:8080/index.html -H 'Host: zhiyu.finddatatech.cloud'` → 200。
2. **公网**：`curl -s https://zhiyu.finddatatech.cloud/ | head -30` → 可见 `<title>智语 · Zhiyu`。
3. **诚实与泄漏门**（任一不过即视为未通过）：

```bash
curl -s https://zhiyu.finddatatech.cloud/ > /tmp/z.html
# 注意：'壹座' 是官方对外产品名（PRODUCT.md:47 五线词表：寻数·壹座 / 识律 / 柏讯 / 谦面 / 萬星），
# 不在内部词之列——站点需要写「壹座产品介绍」团队与「壹座专家」真实席位名，故不设零命中门（2026-11-10 订正）
grep -c '合成' /tmp/z.html            # 必须 ≥1（合成标注未丢）
grep -cE 'yizuo\.local|10\.43\.|NodePort|31899|sub2api|spider-heal' /tmp/z.html  # 必须 0
grep -c '让智能体团队' /tmp/z.html     # 必须 1（首屏文案在位）
```

4. **视觉**：桌面与移动各看一眼——桌面滚动时圆桌应随章节转向（分身席/访客席/门口/桌心），
   移动端章节顺排、席标可读、首屏 H1 与两个按钮在位。
5. **互链**：从 `yongyi.finddatatech.cloud` 能点到智语，反之亦然。

## 九、回滚

旧版留档 `*.bak-pre-<日期>`；回滚=还原三个文件 + `caddy reload`。
DNS 若需摘除，仅需删 A 记录（TTL 600s，10 分钟内生效）。

## 十、不要做

- 不要把 `docs/zhiyu-site-design.md`、`PRODUCT.md`、`.impeccable/` 下的任何文件上传到静态目录
  （它们含内部词清单与设计过程记录）。
- 不要给这个站点加动态接口或反向代理——它是纯静态三文件。
- 不要把 widget 令牌换成任何带写权限的凭据。
