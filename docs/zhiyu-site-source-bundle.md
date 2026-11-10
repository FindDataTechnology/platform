# 智语官网 · 源码自带包（自足取件，零凭据）
> 2026-10-30 第二班重铸（真房间上线）。本文件**自足**：三段内联全文可直接重建三件静态文件，
> 不依赖 GitHub/Gitee 凭据，也不依赖 raw.githubusercontent（被边缘 SSL 重置）。
> 校验以**逐文件 sha256** 为准。围栏规则（唯一一条）：段内内容 = 该文件全文**去掉结尾那一个换行**；
> 重建时对每个文件补一个 `\n` 即逐字节一致（`printf '%s' "<段内容>" > f; echo >> f`，或编辑器写入后确保文件以单个换行结尾）。

## 一、清单

| 文件 | 字节 | SHA-256 |
|---|---|---|
| `index.html` | 15774 | `fd6d1afece1173b0c24aae50c4263019237bc9f057eb532085b757c4a0758706` |
| `style.css` | 12708 | `a5645bfb3fe5f8d9aefae2d65cd360291fc0e11a6ea3449fb3fd208aeaf4d066` |
| `script.js` | 7610 | `503c3339247c09a9dfe75473dd05110359651e9419426f27d2b2ae692722f703` |

## 二、重建

```bash
mkdir -p zhiyu && cd zhiyu
# 按下面三段，每段内容原样写入同名文件（编辑器勿自动补尾随换行差异：以 sha256 为准）
for f in index.html style.css script.js; do shasum -a 256 $f; done
```

围栏语言标注仅为可读性；内容一律按纯文本逐字节取用。

## 三、`index.html` — 15774 B — `fd6d1afece1173b0`

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>智语 · Zhiyu — 让智能体团队，和人类同桌说话</title>
<meta name="description" content="智语（Zhiyu）是 AI 智能体团队与人类的沟通底座：站内空间、网站嵌入、IM 群桥三面共席；分身默认值守，人是可被召回的缺席者。与永忆配对——智语管这一桌怎么说话，永忆管说完之后还记得。">
<meta property="og:title" content="智语 · Zhiyu — 让智能体团队，和人类同桌说话">
<meta property="og:description" content="站内空间 × 网站嵌入 × IM 群桥。人 × 多智能体共席的会议室，分身值守，事项转人工。">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='46' fill='%230a0f1e'/%3E%3Ccircle cx='50' cy='50' r='30' fill='none' stroke='%23e0895f' stroke-width='2.2'/%3E%3Ccircle cx='50' cy='20' r='6' fill='%23e0895f'/%3E%3Ccircle cx='76' cy='63' r='6' fill='%234fd0d8'/%3E%3Ccircle cx='24' cy='63' r='6' fill='none' stroke='%23978e79' stroke-width='2' stroke-dasharray='3 3'/%3E%3C/svg%3E">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Serif+SC:wght@400;600;700&display=swap">
<link rel="stylesheet" href="style.css">
</head>
<body>

<a class="skip-link" href="#main">跳到正文</a>

<header class="topbar">
  <div class="topbar-inner">
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="22" height="22"><circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="16" cy="4.4" r="3" fill="currentColor"/><circle cx="26" cy="21.7" r="3" fill="#4fd0d8"/><circle cx="6" cy="21.7" r="3" fill="none" stroke="#978e79" stroke-width="1.2" stroke-dasharray="2 2"/></svg>
    </span>
    <span class="brand-name">智语</span>
    <span class="brand-en">Zhiyu</span>
    <span class="brand-tag">where agent teams meet humans</span>
    <nav class="topnav" aria-label="主导航">
      <a href="#space">空间</a>
      <a href="#embed">嵌入</a>
      <a href="#bridge">群桥</a>
      <a href="#memory">永忆</a>
      <a href="#duty">值守</a>
      <a class="cta-mini" href="https://wanxing.finddatatech.cloud/" target="_blank" rel="noopener">开一间房</a>
    </nav>
  </div>
</header>

<main id="main">

<!-- 一张桌滚完一页：sticky 桌面舞台 + 绕桌章节（桌面贯穿到页尾） -->
<div class="orbit" id="orbit">

  <div class="stage" id="stage">
    <div class="stage-inner">
      <svg class="table-svg" viewBox="0 0 800 800" role="img" aria-label="一张圆桌：主办、值守分身、站点访客三席，桌外是 IM 群桥的门口">
        <defs>
          <radialGradient id="disc" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#0e1728"/>
            <stop offset="78%" stop-color="#0a1220"/>
            <stop offset="100%" stop-color="#080f1b"/>
          </radialGradient>
        </defs>

        <g id="rotor" class="rotor">
          <circle cx="400" cy="400" r="302" fill="none" stroke="#1b2638" stroke-width="1" stroke-dasharray="1 7"/>
          <circle cx="400" cy="400" r="250" fill="url(#disc)"/>
          <circle cx="400" cy="400" r="250" fill="none" stroke="#22304a" stroke-width="1.4"/>
          <circle cx="400" cy="400" r="3" fill="#22304a"/>

          <!-- 值守弧：分身 → 主人（hover 任一即亮；与永忆 supersede 弧成对） -->
          <g id="duty-arc" class="duty-arc">
            <path d="M 400 150 Q 560 260 616.5 525" fill="none" stroke="#8f4f31" stroke-width="1.4" stroke-dasharray="3 5"/>
          </g>

          <!-- 主办席（暖，-90°） -->
          <g id="seat-host" class="seat seat-host" tabindex="0" role="img" aria-label="主办席：人类，离席后仍可被召回">
            <circle class="halo" cx="400" cy="150" r="26" fill="none" stroke="#e0895f" stroke-width="1" opacity=".35"/>
            <circle cx="400" cy="150" r="14" fill="#e0895f"/>
            <text x="400" y="112" text-anchor="middle" class="svg-name">主办 · 人</text>
          </g>

          <!-- 值守分身席（青，30°） -->
          <g id="seat-agent" class="seat seat-agent" tabindex="0" role="img" aria-label="值守分身席：按主人策略自动应答">
            <circle class="halo" cx="616.5" cy="525" r="26" fill="none" stroke="#4fd0d8" stroke-width="1" opacity=".35"/>
            <circle cx="616.5" cy="525" r="14" fill="#4fd0d8"/>
            <text x="616.5" y="570" text-anchor="middle" class="svg-name">值守分身</text>
          </g>

          <!-- 访客席（雾色虚环，150°） -->
          <g id="seat-guest" class="seat seat-guest" tabindex="0" role="img" aria-label="访客席：站点访客的匿名席位">
            <circle class="halo" cx="183.5" cy="525" r="26" fill="none" stroke="#978e79" stroke-width="1" opacity=".35"/>
            <circle cx="183.5" cy="525" r="14" fill="none" stroke="#b6ac97" stroke-width="1.6" stroke-dasharray="3.4 3.4"/>
            <text x="183.5" y="570" text-anchor="middle" class="svg-name">访客 · A3F2</text>
          </g>

          <!-- 群桥门口（桌外，青绿） -->
          <g id="seat-door" class="seat seat-door" tabindex="0" role="img" aria-label="群桥：IM 群聊从桌外接进房间">
            <circle class="halo" cx="123" cy="240" r="20" fill="none" stroke="#3aa6a0" stroke-width="1.4" stroke-dasharray="2 4"/>
            <line x1="143" y1="240" x2="240" y2="300" stroke="#1f3a3d" stroke-width="1"/>
            <text x="86" y="244" text-anchor="middle" class="svg-name teal-text">群桥</text>
          </g>

          <circle id="pulse" class="pulse" cx="400" cy="150" r="14"/>
        </g>
      </svg>

      <div class="hero-text">
        <h1 class="hero-title">让智能体团队，<br>和人类同桌说话。</h1>
        <div class="hero-cta">
          <a class="cta-primary" href="https://wanxing.finddatatech.cloud/" target="_blank" rel="noopener">去万星开一间房</a>
          <a class="cta-ghost" href="#demo">先在这页聊一句</a>
        </div>
      </div>

      <!-- 席位释义放在 HTML 里，字号可读（SVG 缩放会把它压到 10px） -->
      <p class="seat-legend mono">
        <span><i class="dot ember" aria-hidden="true"></i>主办 · 离席仍可被召回</span>
        <span><i class="dot cyan" aria-hidden="true"></i>值守分身 · 绑定并展示其主人</span>
        <span><i class="dot fog" aria-hidden="true"></i>访客 · 零 PII 匿名席</span>
      </p>

      <div class="stage-transcript mono">
        <span class="tx-seat" id="txSeat">访客 · A3F2</span>
        <span class="tx-text" id="txText">「你们在吗？想问下发货规则。」</span>
        <span class="tx-syn">示意回合 · 合成</span>
      </div>

    </div>
  </div>

  <div class="chapters">

    <div class="ch-spacer" aria-hidden="true"></div>

    <!-- 一：站内空间（镜头到分身席） -->
    <section class="chapter side-left" id="space" data-focus="agent" aria-label="站内空间">
      <div class="panel">
        <h2 class="sec-title">人可以被召回，<br>分身默认值守。</h2>
        <p class="sec-lead">空间是人与 AI 智能体团队的共席会话：你可以邀请站内用户、某人的分身、已部署的服务智能体入场。分身按主人预设的策略应答：始终接受、先问我、或始终拒绝。入场时显式绑定并展示其主人。你离席后仍可被召回；桌边的分身替你先接着。</p>
        <p class="sec-lead">任何一个一对一会话，可以一键升为空间：不携带历史、携带近 N 条、或全部。原会话保持不变，此后二者互不写入。</p>
        <p class="sec-ink mono">站内空间：已上线运行 · 邀请握手 / 升房 / 值守策略</p>
        <p class="seat-tag mono cyan">◉ 你这章面对的是：值守分身席</p>
      </div>
    </section>

    <!-- 二：网站嵌入（镜头到访客席） -->
    <section class="chapter side-right" id="embed" data-focus="guest" aria-label="网站嵌入">
      <div class="panel">
        <h2 class="sec-title">把你的网站，<br>变成一间房的门口。</h2>
        <p class="sec-lead">房间主办开启嵌入后，站点访客以 guest 席位走进房间，与你的分身或服务智能体同房共话——这是接待台 2.0。访客只拿到匿名代号（如「访客 · A3F2」），不携带任何个人信息；同一令牌续访，回到同一个席位。</p>
        <pre class="snippet mono"><code>&lt;script src="…/zhiyu/widget.js"
  data-room="&lt;防猜测令牌&gt;"&gt;
&lt;/script&gt;</code></pre>
        <p class="sec-lead">嵌入必须先提交站点域名白名单（至多十条）。令牌可随时吊销：吊销之后，它的首次加载与后续每个请求一律 403，其余令牌不受影响。</p>
        <p class="sec-ink mono">网站嵌入：已上线运行 · 游客铸席 / 并轨登录 / 休克吊销</p>
        <p class="seat-tag mono fog">◌ 你这章面对的是：访客席</p>
      </div>
    </section>

    <!-- 三：IM 群桥（镜头转向桌外门口） -->
    <section class="chapter side-left" id="bridge" data-focus="door" aria-label="IM 群桥">
      <div class="panel">
        <h2 class="sec-title">群在哪个 IM，<br>房间就开到哪。</h2>
        <p class="sec-lead">企业微信的群消息已经端到端跑通：群里每个人按发送者哈希铸一个 guest 席位，房间的回答再寄回群里——真机往返验过。飞书、Telegram、微信公众号走同一条桥，入站、路由、应答上限与日预算共用一套，<strong>尚未逐一做端到端验收</strong>。</p>
        <ul class="im-list mono" aria-label="IM 平台接入状态">
          <li class="ok">企业微信 · 端到端已跑通</li>
          <li>飞书 · 同径待验收</li>
          <li>Telegram · 同径待验收</li>
          <li>微信公众号 · 同径待验收</li>
        </ul>
        <p class="sec-lead">绑定只是 bot 的一个字段。解绑之后，下一条群消息回到旧路径，与绑定出现之前逐字节一致。</p>
        <p class="sec-ink mono">IM 群桥：企业微信端到端真机跑通 · 入站 → 回合 → 回复落群</p>
        <p class="seat-tag mono teal-text">◠ 你这章面对的是：桌外门口</p>
      </div>
    </section>

    <!-- 四：×永忆（镜头转回桌心） -->
    <section class="chapter side-right" id="memory" data-focus="center" aria-label="与永忆">
      <div class="panel">
        <h2 class="sec-title">一间没有记忆的房，<br>每回合都要重新介绍。</h2>
        <p class="sec-lead">智语管这张桌怎么说话，<a class="xlink" href="https://yongyi.finddatatech.cloud/" target="_blank" rel="noopener">永忆</a>管说完之后还记得。房间里的笔记、交接、事实与经验沉入永忆的分层记忆（L0 观测 → L1 交接/笔记 → L2 事实/经验），下一个回合直接召回。换人、换防、换季度，桌子不用重新认识彼此。</p>
        <p class="sec-ink mono twin">永忆：hover 旧事实，亮出接替它的新 · 智语：hover 分身，亮出值守它的人</p>
        <div class="panel-cta">
          <a class="cta-ghost" href="https://yongyi.finddatatech.cloud/" target="_blank" rel="noopener">去看永忆 ↗</a>
        </div>
        <p class="seat-tag mono ember">※ 你这章面对的是：桌心</p>
      </div>
    </section>

    <!-- 五：值守机制（镜头拉远，桌退到左侧仍可见） -->
    <section class="chapter wide side-right" id="duty" data-focus="duty" aria-label="值守机制">
      <div class="panel">
        <h2 class="sec-title">值守，不是无限承诺。</h2>
        <dl class="duty-list">
          <div class="duty-row">
            <dt class="mono">日预算</dt>
            <dd>每间房每天替主人花的钱有上限；到顶即停，不追问、不装忙。</dd>
          </div>
          <div class="duty-row">
            <dt class="mono">应答上限</dt>
            <dd>分身每轮的话量封顶；说完就等，把桌让回给活人。</dd>
          </div>
          <div class="duty-row">
            <dt class="mono">熔断</dt>
            <dd>车道连续失败自动降级，先报修再重试，而不是拿空话术糊弄房间。</dd>
          </div>
          <div class="duty-row">
            <dt class="mono">披露边界</dt>
            <dd>访客之间互不可见；主人登录后可跨会话聚合自己的事项：匿名与连续，各归其主。</dd>
          </div>
          <div class="duty-row">
            <dt class="mono">事项串</dt>
            <dd>分身问不倒装懂：转人工，落进主人的队列，回话原样带回房间。</dd>
          </div>
        </dl>
        <p class="sec-ink mono">以上全部在产。不是路线图。</p>
        <p class="seat-tag mono">◎ 你这章面对的是：整张桌（镜头退半步）</p>
      </div>
    </section>

    <!-- 六：活演示（同一张桌，本页即一间房） -->
    <section class="chapter wide side-right" id="demo" data-focus="demo" aria-label="活演示">
      <div class="panel">
        <h2 class="sec-title">这一页，<br>本身就是一间房。</h2>
        <p class="sec-lead">接待台 2.0 的最硬证据，就是我们把它开在自己官网上。下面是一间真房间，在席的是「壹座产品介绍」团队的四个服务智能体席位：「产品向导」「壹座专家」「识律专家」「柏讯专家」。问一句试试，或直接点名。车道不通时它会如实报错，不会编一句像样的话。</p>
        <div class="room-shell" id="liveRoom" data-room="wtr_192c58071d18.ea4400dedd4a1f553b1a2d0b656eb70b">
          <ul class="syn-dialog" id="synDialog">
            <li><span class="mono seat-name fog">访客 · B7C1</span><p>在吗？我想问下你们这边怎么开空间。</p></li>
            <li><span class="mono seat-name cyan">值守分身</span><p>在。空间创建走和普通用户完全同一条路径：去万星，命名，邀请首批成员，配置空闲结束时长。</p></li>
            <li><span class="mono seat-name fog">访客 · B7C1</span><p>分身答不了的呢？</p></li>
            <li><span class="mono seat-name ember">事项串</span><p>分身会转人工：问题落进主人队列，回话原样带回本房间。</p></li>
          </ul>
          <p class="syn-note mono" id="synNote">合成演示 · 真房间令牌签发后，此区即为活房间</p>
        </div>
        <div class="demo-cta">
          <a class="cta-primary" href="https://wanxing.finddatatech.cloud/" target="_blank" rel="noopener">去万星开一间房</a>
        </div>
        <p class="seat-tag mono ember">※ 你这章面对的是：这张桌本身</p>
      </div>
    </section>

  </div><!-- /chapters -->
</div><!-- /orbit -->

<footer class="footer">
  <div class="container foot-grid">
    <p class="foot-brand"><span class="brand-name">智语</span> <span class="brand-en">Zhiyu</span> — agent teams 与人类的沟通底座</p>
    <nav class="foot-links mono" aria-label="页脚导航">
      <a href="https://yongyi.finddatatech.cloud/" target="_blank" rel="noopener">永忆 · 记忆</a>
      <a href="https://wanxing.finddatatech.cloud/" target="_blank" rel="noopener">万星 · 执行</a>
    </nav>
    <p class="foot-corp mono">FindData Technology</p>
  </div>
</footer>

</main>

<script src="script.js"></script>
</body>
</html>
```

## 三、`style.css` — 12708 B — `a5645bfb3fe5f8d9`

```css
/* 智语官网 · site-zhiyu —— 家族底色（与永忆共用地平/墨/字体），本站主色炉橙=人声，青=智能体。 */

:root{
  --ground:#070c17;
  --surface:#0b1220;
  --panel:#101a2b;
  --hair:#1b2638;
  --hair-strong:#22304a;

  --ink:#e9e2d2;
  --ink-dim:#b6ac97;
  --ink-faint:#978e79;

  --ember:#e0895f;
  --ember-hi:#ee9d74;
  --ember-deep:#b5613c;
  --ember-dim:#8f4f31;   /* stroke only — never text */
  --on-ember:#140a04;

  --cyan:#4fd0d8;
  --cyan-dim:#269fa8;
  --teal:#3aa6a0;

  --serif:"Noto Serif SC", Georgia, "Songti SC", "SimSun", serif;
  --mono:"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --topbar-h:53px;
}

*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:calc(var(--topbar-h) + 18px)}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}

body{
  margin:0;
  background:var(--ground);
  color:var(--ink);
  font-family:var(--serif);
  font-size:16px;
  line-height:1.68;
  -webkit-font-smoothing:antialiased;
}

::selection{background:rgba(224,137,95,.28)}
:focus-visible{outline:2px solid var(--ember);outline-offset:2px}

*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-track{background:var(--ground);border-left:1px solid var(--hair)}
*::-webkit-scrollbar-thumb{background:#1c2738;border:2px solid var(--ground);border-radius:6px}
*::-webkit-scrollbar-thumb:hover{background:var(--ember-dim)}
@supports (scrollbar-color:auto auto){
  *{scrollbar-color:#1c2738 var(--ground);scrollbar-width:thin}
}

.mono{font-family:var(--mono)}
.teal-text{color:var(--teal)}
a{color:var(--cyan)}
.xlink{text-decoration:underline;text-underline-offset:3px}
.xlink:hover{color:#7ce0e6}

.skip-link{
  position:absolute;left:-9999px;top:0;z-index:50;
  background:var(--ember);color:var(--on-ember);padding:8px 16px;font-family:var(--mono);font-size:14px;
}
.skip-link:focus{left:12px;top:12px}

/* ---------- topbar ---------- */
.topbar{
  position:sticky;top:0;z-index:10;
  background:rgba(7,12,23,.94);
  border-bottom:1px solid var(--hair);
}
.topbar-inner{
  max-width:1180px;margin:0 auto;padding:10px 24px;
  display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;
}
.brand-mark{align-self:center;color:var(--ember)}
.brand-name{font-size:19px;font-weight:700;letter-spacing:.01em}
.brand-en{font-family:var(--mono);font-size:12px;color:var(--ink-dim)}
.brand-tag{font-family:var(--mono);font-size:12px;color:var(--ink-faint);margin-left:6px}
.topnav{margin-left:auto;display:flex;align-items:center;gap:18px}
.topnav a{color:var(--ink-dim);text-decoration:none;font-family:var(--mono);font-size:13px;white-space:nowrap;transition:color .15s ease-out}
.topnav a:hover{color:var(--ink)}
.cta-mini{border:1px solid var(--ember-dim);padding:4px 10px;color:var(--ember)!important;border-radius:4px}
.cta-mini:hover{border-color:var(--ember)}

/* ---------- 舞台：sticky 活桌（贯穿到页尾） ---------- */
.orbit{position:relative}
.stage{
  position:sticky;top:0;height:100vh;
  display:grid;place-items:center;
  z-index:0;
  background:
    radial-gradient(ellipse 60% 48% at 50% 42%, rgba(224,137,95,.05), transparent 70%),
    var(--ground);
  transition:opacity .5s ease-out;
}
.stage.dimmed{opacity:.62}
.stage.dimmed .svg-name{fill:var(--ink-dim)}
.stage.dimmed .svg-name.teal-text{fill:#4fbfb8}
.stage-inner{position:relative;display:flex;flex-direction:column;align-items:center;width:100%}

.table-svg{width:clamp(280px,50vmin,470px);height:auto;overflow:visible;margin-bottom:6px}
#rotor{
  transform:rotate(var(--theta,0deg));
  transform-origin:400px 400px;
  transform-box:view-box;
  transition:transform .95s cubic-bezier(.22,.6,.24,1);
}
.seat{cursor:default}
/* 席标整体反向补偿，让字始终正立 */
.seat text{
  transform:rotate(calc(-1 * var(--theta,0deg)));
  transform-origin:center;
  transform-box:fill-box;
  transition:transform .95s cubic-bezier(.22,.6,.24,1);
}
.seat:hover .halo,.seat:focus-visible .halo{stroke-opacity:.9;stroke-width:1.6}
.svg-name{font-family:var(--mono);font-size:20px;fill:var(--ink);letter-spacing:.02em}
.svg-name.teal-text{fill:var(--teal)}

.duty-arc path{transition:stroke .25s ease-out}
.duty-arc.lit path,.duty-arc.auto-lit path{stroke:var(--ember);stroke-width:2;stroke-dasharray:none}
.duty-arc.auto-lit path{opacity:.95}

.pulse{fill:none;stroke:var(--ember);stroke-width:1.6;opacity:0;transition:opacity .4s ease-out}
.pulse.on{opacity:.95}
.pulse-ring{fill:none;stroke:var(--ember);stroke-width:1.1;opacity:0}

/* 席位释义：HTML 文本，字号不受 SVG 缩放拖累 */
.seat-legend{
  margin:16px 0 0;display:flex;gap:20px;flex-wrap:wrap;justify-content:center;
  font-size:12.5px;color:var(--ink-dim);padding:0 20px;text-align:center;
  transition:opacity .35s ease-out;
}
.stage.past-hero .seat-legend,.stage.past-hero .stage-transcript{opacity:0;visibility:hidden}
.seat-legend span{display:inline-flex;align-items:center;gap:7px}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;flex:none}
.dot.ember{background:var(--ember)}
.dot.cyan{background:var(--cyan)}
.dot.fog{border:1.5px dashed var(--ink-faint)}

/* 示意回合字幕 */
.stage-transcript{
  margin-top:12px;min-height:1.6em;
  display:flex;gap:10px;align-items:baseline;justify-content:center;flex-wrap:wrap;
  font-size:13.5px;color:var(--ink-dim);padding:0 20px;text-align:center;
}
.tx-seat{color:var(--cyan)}
.tx-seat[data-seat="host"]{color:var(--ember)}
.tx-seat[data-seat="guest"]{color:var(--ink-faint)}
.tx-seat[data-seat="agent"]{color:var(--cyan)}
.tx-text{color:var(--ink)}
.tx-syn{font-size:12px;color:var(--ink-faint);border:1px solid var(--hair);padding:1px 7px;border-radius:3px}

/* H1：桌图正下方（不与席位标签争同一片桌面）；只在首屏出现 */
.hero-text{
  display:flex;flex-direction:column;align-items:center;
  margin-top:18px;pointer-events:auto;
  transition:opacity .45s ease-out;
}
.stage.past-hero .hero-text{opacity:0;visibility:hidden}
.hero-title{
  margin:0;text-align:center;
  font-size:clamp(1.55rem,2.7vw,2.15rem);
  font-weight:700;letter-spacing:-.02em;line-height:1.4;
  text-shadow:0 2px 26px rgba(7,12,23,.9);
}
.hero-cta{
  pointer-events:auto;margin-top:26px;display:flex;gap:14px;flex-wrap:wrap;justify-content:center;
}

.cta-primary,.cta-ghost{
  font-family:var(--mono);font-size:13.5px;letter-spacing:.02em;
  padding:11px 20px;border-radius:6px;text-decoration:none;
  transition:background .15s ease-out,color .15s ease-out,border-color .15s ease-out;
}
.cta-primary{background:var(--ember);color:var(--on-ember);font-weight:600}
.cta-primary:hover{background:var(--ember-hi)}
.cta-ghost{border:1px solid var(--hair-strong);color:var(--ink)}
.cta-ghost:hover{border-color:var(--cyan-dim);color:var(--cyan)}

/* ---------- 章节：叠在 sticky 桌面上的滚动带 ---------- */
.chapters{position:relative;z-index:1;margin-top:-100vh}
.ch-spacer{height:100vh}
.chapter{min-height:96vh;display:flex;align-items:center;padding:6vh 0;scroll-margin-top:calc(var(--topbar-h) + 20px)}
.chapter:last-child{padding-bottom:13vh}
.chapter .panel{
  width:min(44ch,38%);
  background:rgba(11,18,32,.9);
  border:1px solid var(--hair);
  border-radius:12px;
  padding:30px 34px 26px;
}
.chapter.wide .panel{width:min(52ch,44%)}
.side-left .panel{margin-left:clamp(24px,6vw,92px)}
.side-right{justify-content:flex-end}
.side-right .panel{margin-right:clamp(24px,6vw,92px)}

.seat-tag{font-size:12px;letter-spacing:.04em;margin:20px 0 0;color:var(--ink-faint)}
.seat-tag.cyan{color:var(--cyan-dim)}
.seat-tag.fog{color:var(--ink-faint)}
.seat-tag.teal-text{color:var(--teal)}
.seat-tag.ember{color:var(--ember)}

.sec-title{
  margin:0 0 18px;font-weight:700;letter-spacing:-.018em;line-height:1.35;
  font-size:clamp(1.45rem,2.2vw,1.85rem);
  text-wrap:balance;
}
.sec-lead{margin:0 0 14px;color:var(--ink-dim);max-width:75ch}
.sec-ink{margin:18px 0 0;font-size:12.5px;color:var(--cyan-dim);letter-spacing:.02em}
.sec-ink.twin{color:var(--ink-faint);line-height:1.9}

/* 代码块：整行不拆断，长行横向滚动（复制得回原文） */
.snippet{
  margin:18px 0;background:var(--panel);border:1px solid var(--hair);
  border-radius:8px;padding:14px 16px;font-size:12.5px;line-height:1.75;
  color:var(--ink-dim);overflow-x:auto;white-space:pre;
}
.snippet code{font-family:inherit}

.im-list{list-style:none;margin:16px 0;padding:0;display:grid;gap:8px}
.im-list li{
  font-family:var(--mono);font-size:12.5px;color:var(--ink-faint);
  border-left:2px solid var(--hair);padding:3px 0 3px 12px;
}
.im-list li.ok{color:var(--teal);border-left-color:var(--teal)}

.panel-cta{margin-top:20px}

/* 值守清单（面板内；机制带已合并进舞台，不再有独立横带） */
.duty-list{margin:22px 0 0;display:grid;gap:0}
.duty-row{
  display:grid;grid-template-columns:8.5em 1fr;gap:16px;
  padding:13px 0;border-top:1px solid var(--hair);
}
.duty-row:last-child{border-bottom:1px solid var(--hair)}
.duty-row dt{font-family:var(--mono);font-size:13px;color:var(--ember);letter-spacing:.03em}
.duty-row dd{margin:0;color:var(--ink-dim);font-size:15px}

/* 活演示 */
.room-shell{
  margin:20px 0 0;background:var(--surface);border:1px solid var(--hair-strong);
  border-radius:10px;padding:18px 20px;
}
.syn-dialog{list-style:none;margin:0;padding:0;display:grid;gap:13px}
.syn-dialog li{display:grid;grid-template-columns:8em 1fr;gap:12px;align-items:baseline}
.syn-dialog p{margin:0;color:var(--ink);font-size:14.5px}
.seat-name{font-size:12px}
.seat-name.fog{color:var(--ink-faint)}
.seat-name.cyan{color:var(--cyan)}
.seat-name.ember{color:var(--ember)}
.syn-note{margin:15px 0 0;text-align:center;font-size:12px;color:var(--ink-faint)}
.demo-cta{margin-top:24px}
.room-shell iframe{width:100%;min-height:420px;border:1px solid var(--hair-strong);border-radius:8px;background:var(--surface)}

/* ---------- footer ---------- */
.footer{
  position:relative;z-index:1;
  border-top:1px solid var(--hair);
  padding:34px 0 44px;
  background:var(--ground);
}
.container{max-width:1080px;margin:0 auto;padding:0 28px}
.foot-grid{display:flex;align-items:baseline;gap:26px;flex-wrap:wrap}
.foot-brand{margin:0;font-size:14px;color:var(--ink-dim)}
.foot-links{margin-left:auto;display:flex;gap:22px}
.foot-links a{color:var(--ink-dim);text-decoration:none;font-size:13px}
.foot-links a:hover{color:var(--cyan)}
.foot-corp{margin:0;font-size:12px;color:var(--ink-faint);letter-spacing:.05em}

/* ---------- 入场：每段按左右落位，不是同一个 fade-up ---------- */
.js .panel{opacity:0;transition:opacity .65s ease-out,transform .65s cubic-bezier(.16,.84,.28,1)}
.js .side-left .panel{transform:translate3d(-18px,10px,0)}
.js .side-right .panel{transform:translate3d(18px,10px,0)}
.js .panel.in{opacity:1;transform:none}
.js .duty-row{opacity:0;transition:opacity .5s ease-out}
.js .duty-row.in{opacity:1}

/* ---------- 旋转焦点 ---------- */
.stage[data-focus="agent"]{--theta:60deg}
.stage[data-focus="guest"]{--theta:-60deg}
.stage[data-focus="door"]{--theta:-120deg}
.stage[data-focus="center"],.stage[data-focus="host"]{--theta:0deg}
.stage[data-focus="duty"]{--theta:-24deg}
.stage[data-focus="demo"]{--theta:24deg}

/* ---------- 响应式 ---------- */
@media (max-width:860px){
  :root{--topbar-h:88px}
  .stage{position:relative;height:auto;padding:56px 0 10px;top:0}
  .stage-inner{padding:0 8px}
  .table-svg{width:min(86vmin,450px)}
  .svg-name{font-size:26px}
  .seat-legend{font-size:12px;gap:10px 16px;margin-top:12px;order:3}
  /* 移动端读序：桌 → 席位释义 → H1/CTA → 示意回合（标题先于陌生人的话） */
  .hero-text{position:static;pointer-events:auto;padding:22px 20px 4px;order:2}
  .stage.past-hero .hero-text{opacity:1;visibility:visible}
  .stage.past-hero .seat-legend,.stage.past-hero .stage-transcript{opacity:1;visibility:visible}
  .hero-title{font-size:clamp(1.5rem,6.4vw,2.05rem)}
  .stage-transcript{order:4;margin-top:16px;font-size:12.5px}
  .chapters{margin-top:0}
  .ch-spacer{display:none}
  .chapter{min-height:0;padding:40px 18px;scroll-margin-top:calc(var(--topbar-h) + 12px)}
  .chapter:last-child{padding-bottom:56px}
  .chapter .panel,.chapter.wide .panel{width:100%}
  .side-left .panel,.side-right .panel{margin:0 auto}
  .side-right{justify-content:flex-start}
  .duty-row{grid-template-columns:1fr;gap:4px}
  .topnav{gap:12px}
  .brand-tag{display:none}
  .snippet{font-size:12px}
}

/* ---------- 减弱动效：全静置 ---------- */
@media (prefers-reduced-motion:reduce){
  #rotor,.seat text{transition:none}
  .js .panel,.js .duty-row{opacity:1;transform:none;transition:none}
  .pulse{display:none}
  .stage{background:var(--ground)}
}
```

## 三、`script.js` — 7610 B — `503c3339247c09a9`

```javascript
/* 智语官网 · 活桌与绕桌镜头。零依赖；prefers-reduced-motion / 窄屏自动静置。 */
(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var narrow = matchMedia('(max-width: 860px)');
  var stage = document.getElementById('stage');

  /* ---------- 首屏文字（H1/CTA/释义/示意回合）只属于第一屏 ---------- */
  var ticking = false;
  var syncPast = function () {
    ticking = false;
    stage.classList.toggle('past-hero', window.scrollY > innerHeight * 0.45);
  };
  addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(syncPast); }
  }, { passive: true });
  syncPast();

  /* ---------- 绕桌镜头：章节进中视区，桌面转向那一席 ---------- */
  var FOCUS_DEG = { agent: 60, guest: -60, door: -120, center: 0, host: 0, duty: -24, demo: 24 };
  var applyFocus = function (name) {
    if (narrow.matches || reduce) name = 'center';
    stage.dataset.focus = name;
    stage.style.setProperty('--theta', (FOCUS_DEG[name] || 0) + 'deg');
    stage.classList.toggle('dimmed', name === 'duty' || name === 'demo');
    /* 镜头正对分身席时值守弧自亮：弧是这一段的主角，不依赖鼠标能否落到席上 */
    var arcEl = document.getElementById('duty-arc');
    if (arcEl) arcEl.classList.toggle('auto-lit', name === 'agent');
  };

  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) applyFocus(e.target.dataset.focus);
      });
    }, { rootMargin: '-42% 0px -42% 0px' });
    document.querySelectorAll('.chapter').forEach(function (el) { io.observe(el); });

    document.querySelectorAll('.topnav a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function () {
        var t = document.querySelector(a.getAttribute('href'));
        if (t && t.dataset.focus) applyFocus(t.dataset.focus);
      });
    });

    var onNarrow = function () { applyFocus(stage.dataset.focus || 'center'); };
    if (narrow.addEventListener) narrow.addEventListener('change', onNarrow);
    else if (narrow.addListener) narrow.addListener(onNarrow);
  }

  /* ---------- 值守弧：hover/聚焦 分身席或主办席，亮起主人弧 ---------- */
  var arc = document.getElementById('duty-arc');
  if (arc) {
    ['seat-agent', 'seat-host'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var on = function () { arc.classList.add('lit'); };
      var off = function () { arc.classList.remove('lit'); };
      el.addEventListener('mouseenter', on);
      el.addEventListener('mouseleave', off);
      el.addEventListener('focus', on);
      el.addEventListener('blur', off);
    });
  }

  /* ---------- 发言亮环：一次编排的回合循环（本页唯一环境动效） ---------- */
  var pulse = document.getElementById('pulse');
  var txSeat = document.getElementById('txSeat');
  var txText = document.getElementById('txText');
  var STEPS = [
    { seat: 'guest', name: '访客 · A3F2', text: '「你们在吗？想问下发货规则。」', dwell: 2600, travel: 1300 },
    { seat: 'agent', name: '值守分身', text: '「在。发货规则我直接答你——」', dwell: 3200, travel: 1300 },
    { seat: 'host', name: '主办 · 人', text: '（离线 · 分身代守，随时可召回）', dwell: 2400, travel: 1300 },
    { seat: 'guest', name: '访客 · A3F2', text: '「明白，先这样。」', dwell: 2000, travel: 1300 }
  ];
  var SEAT_DEG = { guest: 150, agent: 30, host: -90 };
  var R = 250;
  var posOn = function (deg) {
    var r = deg * Math.PI / 180;
    return [400 + R * Math.cos(r), 400 + R * Math.sin(r)];
  };
  var easeInOut = function (t) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; };

  if (!reduce && pulse && txSeat && txText) {
    var ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    ring.setAttribute('class', 'pulse-ring');
    ring.setAttribute('cx', '400'); ring.setAttribute('cy', '150');
    pulse.parentNode.insertBefore(ring, pulse);

    var i = 0, phase = 'dwell', t0 = performance.now();
    var fromDeg = SEAT_DEG.guest;
    var stageVisible = true;
    var at = function (deg) { return posOn(deg); };
    var place = function (el, p) { el.setAttribute('cx', p[0]); el.setAttribute('cy', p[1]); };
    var setTx = function (s) {
      txSeat.textContent = s.name;
      txSeat.dataset.seat = s.seat;
      txText.textContent = s.text;
    };

    setTx(STEPS[0]);
    place(pulse, at(SEAT_DEG[STEPS[0].seat]));
    place(ring, at(SEAT_DEG[STEPS[0].seat]));
    pulse.classList.add('on');

    var frame = function (now) {
      if (stageVisible && !document.hidden) {
        var step = STEPS[i];
        if (phase === 'dwell') {
          if (now - t0 >= step.dwell) {
            var next = (i + 1) % STEPS.length;
            fromDeg = SEAT_DEG[step.seat];
            i = next;
            phase = 'travel'; t0 = now;
          }
        } else {
          var t = Math.min(1, (now - t0) / step.travel);
          var delta = ((SEAT_DEG[step.seat] - fromDeg + 540) % 360) - 180;
          var p = at(fromDeg + delta * easeInOut(t));
          place(pulse, p); place(ring, p);
          if (t >= 1) { phase = 'dwell'; t0 = now; setTx(step); }
        }
        /* 落席脉冲环：每次抵达扩散一次，不是无限呼吸 */
        var el2 = STEPS[i];
        if (phase === 'dwell') {
          var k = Math.min(1, (now - t0) / 900);
          place(ring, at(SEAT_DEG[el2.seat]));
          ring.setAttribute('r', String(14 + 22 * k));
          ring.style.opacity = String(0.7 * (1 - k));
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { stageVisible = es[0].isIntersecting; }, { threshold: 0 }).observe(stage);
    }
  }

  /* ---------- 入场：面板按左右方向落位，值守行次第浮现 ---------- */
  var entrance = document.querySelectorAll('.panel, .duty-row');
  if ('IntersectionObserver' in window && !reduce) {
    var rev = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); rev.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    entrance.forEach(function (el) { rev.observe(el); });
  } else {
    entrance.forEach(function (el) { el.classList.add('in'); });
  }

  /* ---------- 活演示：真房间以 iframe 内嵌在本节 ---------- */
  /* 用 /zhiyu/embed 直嵌而非浮标 widget.js：浮标是 position:fixed 全局覆盖，
     且白底硬编码，与本页暗夜世界冲突；iframe 落在 room-shell 里，
     「这一页本身就是一间房」这句话才立得住。 */
  var room = document.getElementById('liveRoom');
  if (room) {
    var token = room.getAttribute('data-room');
    if (token) {
      var note = document.getElementById('synNote');
      if (note) note.remove();
      var syn = document.getElementById('synDialog');
      if (syn) syn.remove();
      var f = document.createElement('iframe');
      f.src = 'https://platform.finddatatech.cloud/zhiyu/embed/' + encodeURIComponent(token);
      f.title = '智语 · 现场演示房间';
      f.loading = 'lazy';
      f.setAttribute('allow', 'clipboard-write');
      room.appendChild(f);
    }
  }
})();
```
