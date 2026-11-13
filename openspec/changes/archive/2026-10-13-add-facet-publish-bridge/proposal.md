## Why

F3.2（`docs/facet-market-roadmap.md`）：自部署者在自己实例上创作并发布的功集，今天
没有任何一条路回流官方市场——重发只能手工抄 manifest 到官方域的网页发布框。跨实例
传输体按路线图定案=我们的 CLI：登录、清单校验、发布门（creators 组、工具声明门、
限流）全部在官方侧原样复用，CLI 只做搬运，不自设任何鉴权。

缺口：配对三门（`/api/app/pair|challenge|login`）与绑定码铸造只挂在壹座网关上；facet
服务的身份解析只有 Logto 会话+壹座代理两条通道——CLI 对官方市场域无法完成设备配对，
也无法持 app token 过发布门。

## What Changes

- **facet 配对面**（新模块 `facet/pairing.js`，全部复用既有模块）：facet 挂载设备配对
  三门+绑定码铸造+设备管理面；`MP_TOKEN_SECRET` 缺省时诚实关闭（与网关同一道闸）；
  身份解析增第三通道（app Bearer token，`kind=app` 校验后携账号身份）。
- **CLI `publish`**：`facet publish <manifest.json | packRef> [--from <自部署实例>]`
  `[--pack-id <官方id>] [--new] [--market <url>]`——本地清单文件或从自部署实例公开
  detail 拉取完整 manifest（含 skills content），推送官方 `POST /api/packs`；按需配对
  （打印/打开绑定码页，stdin 读 6 位码），每次运行静默续登（challenge+Ed25519 签名+
  login），token 只活在内存；源包 id→官方 id 映射落 `~/.facet/` 供后续版本续推。
- **门全部官方侧**：creators 门、manifest 校验、工具声明门、作者限流——CLI 透传验证
  错误（`errors[]`）与 403/404 门语，不自作任何放行判断。
- MineView 发布框补 CLI 回流提示；`docs/creating-packs.md` 增回流节。

## Impact

- facet/index.js+新模块、facet/cli、facet/web 文案、docs；镜像滚（facet 面必滚，platform
  面随同源镜像）；官方实例既有发布路径零变化。
- specs：device-pairing-auth（配对面也开在 facet 服务）、facet-platform（两通道→三通道，
  重命名=REMOVED+ADDED）、facet-editor-cli（CLI publish 桥需求）。
