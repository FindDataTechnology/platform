# show-ciyuan-video-on-home — 任务清单

> 视频能力（Seedance 任务协议）已上产但三处露出面为零；另修车道卡徽标未贴底。
> 口径纪律：视频写原生任务协议路径（`/v1/contents/generations/tasks`），
> 不写 `/videos`（openai 组 404）；不列具体模型名；不写价目。

## 1. 首页源码（单一事实源）

- [x] 1.1 `docs/ciyuan/home-content.html` 车道段导语改口径（三车道 + 视频）
- [x] 1.2 CSS：`.lane` 加 `display:flex;flex-direction:column`，`.meter` 加 `margin-top:auto`
- [x] 1.3 新增视频生成条目（端点/计量口径 + `model`/`content` 形状要点）+ 快速上手区
      视频 curl（POST 创建 + GET 轮询）
- [x] 1.4 口径自检：无价目数字、无上游供应商名、无模型名清单

## 2. 首页灌入与验收

- [x] 2.1 `apply-ciyuan-home.mjs --dry-run` 通过 → 实灌（只写 `home_content`）
- [x] 2.2 回读设置：`site_name` 等其他键不变
- [x] 2.3 浏览器验收（桌面宽）：四卡徽标贴底（实测距底一致）；视频条目可见
- [x] 2.4 浏览器验收（窄屏）：单列堆叠不破版

## 3. 官网页（fd-official-web）

- [x] 3.1 `src/content/apps/zh/finddatarouter.md`：补视频能力段（与首页同口径）
- [x] 3.2 `src/content/apps/en/finddatarouter.md`：同步英文
- [x] 3.3 提交推 main → `fd-build-channel` 判路出片 → GitOps 滚 fd-web → 线上眼见

## 4. 介绍文档（伙伴用）

- [x] 4.1 `finddata/docs/ciyuan-intro.md`：能力清单补视频行 + 快速上手补视频示例
- [x] 4.2 口径对拍：视频条目与首页表述一致；无内部信息泄露检查

## 5. 收口

- [x] 5.1 `docs/registry-maintenance.md` 发布记录（官网页滚产）
- [x] 5.2 change 归档（openspec archive）
