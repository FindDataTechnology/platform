# polish-facet-interactions

## Why

用户验收谦面生产面（2026-10-13 截图三处）暴露的交互问题：① 功能集/MCP/文档等工具面扛着营销级完整页脚（品牌块+产品线天梯+入口+使命句），信息噪音大，合规备案行被淹没——只有落地页需要营销叙事，其余页面只需要备案行；② 详情弹窗（共享组件）没有任何可见关闭方式（只有 Esc/点遮罩），「订阅并安装」埋在 85vh 内部滚动流的最底部（技能/角色/部署节一长就看不见），且匿名访客点击后裸奔英文「Authentication required」——没有引导、没有登录入口；③ 「部署为服务」节集中了三组无解释黑话（部署/节奏/计量 key），首次看不懂。

## What Changes

- **细页脚**：`PageFooter` 增 slim 形态（仅备案行：© 2026 寻数（FindData）· 谦面 Facet + 粤ICP备 + 粤公网安备，同链接）。谦面壳六个视图里，仅落地页 `#/` 渲染完整页脚，`#/packs`、`#/mcp`、`#/docs`、`#/mine`、`#/curate` 全部渲染 slim。
- **详情弹窗固定操作底栏**（共享组件 PackDetailDialog）：操作按钮从内容流抽出，改为弹窗底部固定栏（始终可见、随内容滚动分离）：主按钮「订阅并安装」+ 次按钮可见的「✕ 关闭」。`onGotoMine` 按钮由宿主决定（谦面壳不传——谦面无装机面，语义错位；壹座侧不变）。
- **匿名点击→登录引导**：壳把登录态传进弹窗（`onRequireLogin` prop）。匿名点「订阅并安装」→ 底栏内联翻出引导行「订阅并安装需要登录」+「去登录」按钮（整页跳 `/auth/login?rd=`+当前 URL，登录后经既有 safeReturnPath 回 `#/packs`；不恢复弹窗状态，重开成本≈0）。壹座侧缺省不传 = 现有 401 错误兜底路径不变（壹座用户恒有会话，该分支是边界态）。401 错误兜底文案同步本地化。
- **部署节人话文案**：部署为服务节加开头说明（部署=上线可对话服务：公开对话页+按回合计量+部署者分成）与三区块各一句副标题（计量 key=访客回合费买单额度；节奏=要不要定时唤醒自主干活、不加即纯应答）；部署按钮旁给结果预期（部署后得到可分享对话页）。轻量粒度（不做帮助中心）。双语。匿名照常可预览全节（不设动作门槛）。
- 哨兵 e2e 扩展：slim 页脚按视图断言 + 固定底栏常驻断言 + 匿名点订阅→登录引导行出现。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `facet-platform`：
  - MODIFIED「The shell footer carries the five-line ladder」——天梯从「all views」收窄为「the intro landing」；其余视图换备案细页脚。场景「ladder on every view」改为「ladder on the intro landing」+ 新场景「tool views carry the filing-only footer」。
  - MODIFIED「The shell footer carries brand, contact, mission, and filing statements」——品牌/联系/入口/使命句限定 intro 落地页；备案行（copyright+两备案链接） SHALL 出现在所有视图（slim 形态）。场景相应改写+新增。
- `pack-marketplace`：
  - ADDED「The pack detail dialog carries an always-visible action bar」——固定底栏（订阅+关闭）、匿名登录引导、宿主可选 onGotoMine/onRequireLogin 缺省语义。
  - MODIFIED「Browse, search, and inspect」——不涉需求级变化，撤回（部署文案是呈现层，现有 deploy 需求已覆盖行为）。

## Impact

- `facet/web/src/PageFooter.tsx`：slim 形态（variant prop 或导出 FilingFooter）。
- `facet/web/src/App.tsx`：按视图选页脚；登录态传入弹窗链。
- `web/src/components/packs/PackDetailDialog.tsx`（共享）：固定底栏重构 + onRequireLogin prop + 401 兜底文案本地化。
- `web/src/components/packs/PackMarketView.tsx`：透传新 props。
- `web/src/locales/`：新增键（登录引导/部署节副标题/结果预期，五语）。
- 壹座侧零适配（缺省路径行为不变）；部署节文案两域共享受益。
- e2e：facet-shell.spec 扩展；packs.spec 既有断言核对（按钮 data-testid 不变）。
