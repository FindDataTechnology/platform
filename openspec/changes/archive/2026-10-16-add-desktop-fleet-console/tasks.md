# Tasks: add-desktop-fleet-console

## 1. cell server 舰队端点

- [x] 1.1 `server/routes/wanxing-fleet.js`：live 透传+catalog 代理+503 降级+
      cell 鉴权；server.js 注册
- [x] 1.2 单测 `scripts/test-desktop-fleet-console.mjs`（透传/两降级/鉴权门/字段映射）

## 2. 舰队页

- [x] 2.1 `web/src/pages/FleetPage.tsx`：live 区（agents 表+budget）+catalog 区+
      降级引导态+部署按钮禁用注记
- [x] 2.2 Sidebar `/fleet` tab+App 路由+i18n 五语（nav.fleet+页面键）

## 3. 托盘驻留

- [x] 3.1 `electron/main.js`：window-all-closed 驻留+Tray（显示/退出）+图标路径
- [x] 3.2 退出路径复用既定 stopping 流程（drain 断言不变）

## 4. 验收与收尾

- [x] 4.1 探针 `scripts/probe-desktop-fleet-console.mjs`：stub runner+真路由
      express app → live/catalog/两降级断言
- [x] 4.2 web 构建绿（npm run web:build 或 typecheck 快道）
- [x] 4.3 底稿回写（②范围收口+部署链挪③依据）+提交
