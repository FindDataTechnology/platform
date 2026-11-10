# DESIGN.md — 智语官网（site-zhiyu/）

> 本文件只管辖 `site-zhiyu/`（智语营销站，纯静态三文件）。仓库根 `DESIGN.md` 管辖
> Platform 工作台（web 应用）；两者是**两个世界**，共用产品真相，不共用 token。
> 本文件在站点建成之后书写，描述已交付的世界；不是施工前的规则书。

## 家族关系（与永忆站）

智语站与永忆站（`~/finddata/fd-memory/site/`，线上 `yongyi.finddatatech.cloud`）是**孪生站**：
同一块深夜地、同一套墨、同一对字体、同一条「不发明价格/客户/benchmark」诚实纪律，
各领一个语义主色与一个签名交互。

| | 永忆 YongYi | 智语 Zhiyu |
|---|---|---|
| 管什么 | 组织记得 | 组织说话 |
| 主色语义 | 青 = 语义召回 · 琥珀 = 新写入 | **炉橙 = 人声/在场** · 青 = 智能体侧 · 青绿 = IM 门口 |
| 签名交互 | supersede 弧：hover 旧事实 → 亮出接替它的新事实 | **值守弧**：hover 分身 → 亮出值守它的人 |
| 签名构造 | 漂浮星群（静物天象） | **活桌**（一张桌绕镜头，动） |
| 首屏语言 | 「会话会结束，记忆不结束。」 | 「让智能体团队，和人类同桌说话。」 |

**琥珀是永忆的**：本站不把琥珀用于任何语义，焦圈与选中归炉橙。这是家族分工，不是遗漏。

## Own-world identity

- **Palette**（无渐变文字，无装饰性玻璃，投影只给浮起层）：
  - ground `#070c17`（深夜，与永忆同值）
  - surface `#0b1220` / panel `#101a2b`
  - hairline `#1b2638` / 强线 `#22304a`
  - ink `#e9e2d2`（主文，warm off-white）/ ink-dim `#b6ac97`（次文）/ ink-faint `#978e79`（雾文）
  - **ember `#e0895f`** / ember-hi `#ee9d74` / ember-deep `#b5613c`（文字级最低档）/ ember-dim `#8f4f31`（**仅 stroke，禁作文字**）
  - cyan `#4fd0d8` / cyan-dim `#269fa8`（智能体席、链接、在产证据行）
  - teal `#3aa6a0`（群桥门口）
  - on-ember `#140a04`（炉橙上的字）
- **Type**：display/body = **Noto Serif SC**；坐标/标签/代码 = **IBM Plex Mono**（Google Fonts CDN，失败回落本机宋体/等宽）。
  display tracking `-0.018em`；body measure 65–75ch；**正文最小 12px**（检测器 mechanical 门要求）。
- **Signature construct · 活桌**（`index.html` 内的 `#table-svg` 手绘 SVG，非图片、非图标卡片）：
  圆桌 r=250，桌心 400,400；主办席（炉橙实点，-90°）、值守分身席（青实点，30°）、
  访客席（雾色虚环，150°）、桌外群桥门口（青绿虚圆 + 引线，约 210°）。
  **值守弧**：分身席 → 主办席的虚线弧，hover/聚焦任一席即亮（`#duty-arc.lit`）。
  **发言亮环**：`#pulse` + `#pulse-ring`，随回合循环沿桌边跳到当前发言席，落席扩环一次。
- **绕桌镜头**：`.stage` 是 sticky 100vh 舞台；`#orbit` 内 `.chapters` 以 `margin-top:-100vh` 叠回，
  `.ch-spacer` 占位首屏。章节进中视区（`rootMargin:-42%`）→ `stage[data-focus]` 设定
  `--theta`（agent 60° / guest -60° / door -120° / center 0°），`#rotor` 与 `.seat-label` 反向补偿，
  0.95s cubic-bezier(.22,.6,.24,1)。
- **首屏层序**（DOM 顺序即桌面阅读顺序）：桌图 → H1+双 CTA → 席位释义 → 示意回合字幕。
  H1 在桌图**下方**，不压桌心（压桌心会盖住「访客 · A3F2」「值守分身」两枚席标）。
  移动端用 order 重排为：桌 → H1/CTA → 释义 → 示意回合（标题必须先于陌生人的话）。
- **滚过首屏**：`.stage.past-hero`（scrollY > 45vh）淡出 H1、CTA、席位释义与示意回合
  （它们在章节里会被面板压住或裁切），只留活桌与席标。

## 章节 ↔ 席位映射（信息架构，不可随意重排）

| 章节 | 焦点 | 语义 |
|---|---|---|
| `#space` 站内空间 | agent 席 | 分身默认值守、主人策略、升房三选 |
| `#embed` 网站嵌入 | guest 席 | 接待台 2.0、guest 匿名席、域名白名单、休克吊销 |
| `#bridge` IM 群桥 | door | 四平台、哈希铸席、绑定即字段、解绑逐字节回旧径 |
| `#memory` ×永忆 | center | 桌管说话 / 永忆管记得；L0→L2；twin 弧对照 |
| `#duty` 值守机制 | duty（桌面暗退、θ=-24°） | 日预算/应答上限/熔断/披露边界/事项串（五行） |
| `#demo` 活演示 | demo（桌面暗退、θ=+24°） | 本页即一间房；有令牌则挂真 widget，否则合成演示 |

**六章全在 `.orbit` 内**：滚动到底之前，活桌从不消失（THESIS 的硬约束）。页脚在 orbit 之外。
duty/demo 两章的桌面 `.dimmed`（opacity .55）+ 轻微转 24°，读作「镜头退半步，桌还在」，不是换场。

## 诚实性纪律（本站的硬约束）

- 文案只写**有生产证据**的面：站内空间（已上线）、网站嵌入（已上线）、企业微信端到端真机、
  事项串转人工、日预算/应答上限/熔断/披露边界。守则句「以上全部在产。不是路线图。」
- **合成必标**：首屏字幕带「示意回合 · 合成」；活演示无令牌时标「合成演示 · 真房间令牌签发后此区即为活房间」。
- **不发明**：价格、客户名、benchmark、用户证言一律没有。
- **内部词零外露**：`cell`/`fleet`/`k8s`/`NodePort`/内网 IP/`sub2api`/`cheap-N` 不出现在三文件
  （已 grep 验证 0 命中）。`万星` 只作为 CTA 落点与域名。
  **`壹座` 不在此列**（2026-11-10 订正）：`PRODUCT.md:47` 的官方口径是「Product name: 壹座 (Yizuo)」，
  五线词表为 寻数·壹座（base）/ 识律 / 柏讯 / 谦面 / 萬星（智语挂在萬星下）——它是**对外产品名**，
  因此站内可以写「壹座产品介绍」团队与「壹座专家」席位（房里的真实席位显示名）。原先把 `壹座`
  列进内部词并声称"已 grep 验证 0 命中"，与实际文案（及验收门 `grep -c 壹座` = 1）矛盾，属过期条目。
- 品牌面：站主打 `智语`；`万星·智语` 只在正文/CTA 语境。

## Motion

只有**一个**编排的环境动效：发言亮环回合循环（访客 → 分身 → 主办 → 访客，每站 dwell 2.0–3.2s、
travel 1.3s）。其余为辅：绕桌 0.95s、值守弧 0.25s stroke。

**入场不做统一 fade-up**（同一种上浮铺满全站是机械感）：左栏面板自左 18px 落位、右栏面板
自右 18px 落位（`.side-left/.side-right .panel`），值守行只淡入不位移。各一次性，Observer 后 unobserve。
**值守弧两种亮法**：hover/聚焦分身席或主办席（`.lit`），或镜头正对该席时自动亮（`.auto-lit`，
因为章节面板会遮住桌面，鼠标未必落到席上）。
`prefers-reduced-motion: reduce` → 停旋转、停亮环、reveal 直接可见、桌图静置。
滚动离开舞台（IntersectionObserver）与 `document.hidden` 时暂停 rAF。

## Responsive

- ≥861px：sticky 舞台 + 章节左右交错（`.side-left` / `.side-right`），面板宽 `min(46ch,42%)`。
- ≤860px：舞台取消 sticky（`position:relative`，高度自适应），首屏文字回到文档流，
  `.ch-spacer` 隐藏，章节单列；**SVG 席标放到 26px、副标与弧标取消**（viewBox 缩放后仍可读），
  席位释义改为 HTML 行内文本，字号不随 SVG 缩放。`--topbar-h` 在窄屏为上 88px，
  `scroll-padding-top`/`scroll-margin-top` 保证锚点跳转时标题不被吸顶栏切掉。

## 浏览器面

`::selection` 炉橙 28%；滚动条轨道接 ground、拇指 `#1c2738` hover 转 ember-dim；
`:focus-visible` 2px 炉橙 + 2px offset；链接下划线 offset 3px；`html{scroll-behavior:smooth}`（reduced-motion 取消）。

## Files

- `index.html` — 全站结构与全部文案（zh-CN 领）
- `style.css` — token + 舞台/章节/收束带/响应式
- `script.js` — 绕桌镜头、值守弧、发言亮环、reveal、活演示 widget 挂载
- 部署需求：`docs/zhiyu-site-deploy-requirements.md`（雷池侧执行）

## Never

- 不用琥珀做任何语义（琥珀是永忆的写入语义）；焦圈与选中归炉橙
- 不发明价格/客户/benchmark/证言；不把路线图说成在产
- 不泄露内部拓扑、平台内名、IP、k8s/库名/账号
- 不引第二套字体或图标语言（无 emoji 当图标）
- 不给静止元素加投影；不做渐变文字与装饰玻璃
- 不把活桌换成静态图片替身；不要在 reduced-motion 下仍跑循环
- 不让任何章节落到 orbit 之外（桌面必须撑到页脚之前）
- 不把 H1 压回桌心（会盖住席标）；不在章节里保留首屏释义/字幕（会被面板裁切）
- 不把「未逐一验收」的 IM 通道写成已跑通
- 章节席位映射不得重排（每章必须从它面对的那一席展开）
