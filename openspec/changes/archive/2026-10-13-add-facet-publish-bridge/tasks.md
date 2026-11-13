# Tasks — add-facet-publish-bridge（F3.2）

- [x] 1.1 `facet/pairing.js`：配对三门+bindcode+设备管理面+`withAppBearer`（复用
      app-auth/mp-bindings；未配 secret 诚实 503）
- [x] 1.2 facet/index.js 接线：bindings 落 DATA_ROOT、resolveUser 第三通道、路由挂载
- [x] 1.3 CLI `publish`：载荷两源（本地清单/--from 拉取）+按需配对+静默续登+发布+
      id 映射；USAGE/版本号 v0.3.0
- [x] 2.1 测试：pairing 模块端到端 6/6（真路由+真加密+真 packs 落库）+ CLI publish
      三态 3/3（本地/跨实例/门语）；lint（本片文件）+facet/web build 绿
- [x] 2.2 MineView 回流提示+docs/creating-packs.md 回流节
- [ ] 3.1 提交→镜像滚（facet 面）→生产实证：跨实例拉推+配对+发布门+静默续登
- [ ] 3.2 归档+路线图 F3.2 ✅+记忆

## 验收实证（2026-10-13 生产）

- 测试 9/9：模块端到端 6/6（铸码→配对→Bearer 发布落库→静默续登 v2→非 creator 403→
  吊销 binding_required→无 secret 诚实 503→通道优先级）+ CLI 子进程三态 3/3。
- 出片：首片 f9d54dc 崩启动——Dockerfile facet 枚举拷贝漏新文件 pairing.js
  （ERR_MODULE_NOT_FOUND）；5304bc5 补拷贝重出 sha-70b3b61（facet Recreate 滚，
  boot log `pairing armed`）。
- 生产实证全链：platform-test 入 creators 组织（角色 creators；groups=id+角色名，
  重登后 whoami creator:true）→ ego-browser 会话铸码（新 CLI 配对页文案在产）→
  真 CLI `publish <id> --from http://127.0.0.1:3299`（本地第二实例跑同版本代码、
  匿名读面）→ **官方市场 vjGx6hUGyEC5vrIeb9rX9Q v1**（作者=配对账号；技能内容
  逐字搬运；notes 在）→ 二跑零提示静默续登+映射续推 **v2** → 作者会话下架清理
  （匿名 404）。token 零落盘（identity/map 文件形状核对）。
- 配对门滚前 404→滚后 401（绑定码无效）= 门活性独立实证。
- OSS 815a191（快照基 49be769，含并行会话全部新作；force-with-lease 滚动快照语义）。
