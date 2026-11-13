# 任务：对齐小程序身份路径的共享形状

- [ ] 1.1 抽出共享渲染器 `gateway/mp-bind-page.js`（保留页面逐字节等价：账号行、6 位码、5 分钟文案、刷新链接）
- [ ] 1.2 两个宿主改调共享渲染器（`gateway/index.js`、`server/routes/mp.js`），删除两份内联 HTML
- [ ] 1.3 spec delta 改写并 `openspec validate --strict` 通过
- [ ] 1.4 回归：`test-mp-auth` + `test-mp-single-auth` 全绿（页面仍含 6 位码与账号名）
- [ ] 1.5 归档
