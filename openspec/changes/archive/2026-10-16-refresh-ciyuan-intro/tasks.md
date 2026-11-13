# refresh-ciyuan-intro — 任务清单

> 首页落后于产品：三车道零提及、词元品牌缺位、快速上手只教 chat；且 home_content
> 只活在 DB 无仓内源码（结构性缺口）。方案=单一事实源 + 重写 + 官网页对齐。

## 1. 单一事实源

- [x] 1.1 基线副本入库：`docs/ciyuan/home-content.baseline-2026-10-05.html`
      （现网 23901 字符原文，回滚锚）
- [x] 1.2 新首页入库：`docs/ciyuan/home-content.html`（词元品牌 + 三车道段 + 车道示例）
- [x] 1.3 灌入脚本 `scripts/apply-ciyuan-home.mjs`：读文件 → admin API 部分 PUT
      （只发 `home_content`）；支持 `--dry-run`（打印新旧长度与段标题）与
      `--restore-baseline`

## 2. 灌入与验证

- [x] 2.1 dry-run 复核段标题齐全（hero/产品条线/快速上手/模型车道/Agent 服务/计费/页脚）
- [x] 2.2 正式灌入 + 回读确认 `home_content` 长度与首尾标记
- [x] 2.3 浏览器验首页：桌面 + 移动宽度；确认三车道段渲染、链接可达（`/login`、
      `/lanes` 入口、官网五线页）
- [x] 2.4 回归确认：`/lanes` 面板页不受影响；公开设置其余键未被重置（site_name 等）

## 3. 官网 app 页

- [x] 3.1 `fd-official-web` 改 `src/content/apps/zh/finddatarouter.md`：加「模型车道」
      小节 + tagline/kind 更新（保留 demoUrl）
- [x] 3.2 同改 `src/content/apps/en/finddatarouter.md`（英中对称）
- [x] 3.3 本地构建绿 + 出片滚官网（公开仓线）+ 线上复核页面
