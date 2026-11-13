# 设计 — 网页端藏舰队导航

## 决策

### D1 — 检测 = preload bridge 存在，不引新依赖

`window.platform?.pickWorkdir` 的 `typeof` 检测是本仓既有惯用法（`Sidebar.tsx:78` `CAN_PICK_NATIVE`、`ControlStrip.tsx` 同款）。舰队门控提为**共享常量**（如 `web/src/lib/environment.ts` 新 `IS_DESKTOP`，或就近放 Sidebar 同款常量导出），Sidebar 与 FleetPage 共用——同一份检测，两处行为分叉（导航隐藏 / 页面降级）不可能不一致。不引 `is-electron` 之类依赖；userAgent 嗅探不可靠（Electron UA 可被改）。

### D2 — 浏览器直达落说明页，不重定向

重定向到首页会让「为什么没有这页」不可解释；说明页保留 URL、一段桌面专属解释 + 打开桌面 App 的引导（复用既有 download/app 引导文案或 appCatalog）。页面在非桌面壳**不发起** `/api/wanxing/fleet/live`、`/fleet/catalog` 轮询（现在的 useEffect 无条件轮询 → 加 `IS_DESKTOP` 门）。

### D3 — testid 保持

桌面端 `nav-fleet`、两读区 testid 全部不变（e2e 无回归面）；浏览器直达说明页加 `fleet-desktop-only` testid。

## 测试

- e2e（新 2 条，放既有 fleet/app-center 附近的 spec 或新文件）：浏览器态 `nav-fleet` 不存在；直达 `/fleet` 见 `fleet-desktop-only` 且无 live 读区。桌面态回归靠 typecheck+既有 spec（Electron 壳 e2e 无既有项目，不新增）。
