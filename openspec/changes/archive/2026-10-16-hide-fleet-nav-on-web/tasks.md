# Tasks — hide-fleet-nav-on-web

## 1. 检测常量

- [x] 1.1 `web/src/lib/environment.ts` 新建 `export const IS_DESKTOP = typeof window !== "undefined" && typeof window.platform?.pickWorkdir === "function"`（注释引用既有惯用法来源）

## 2. 侧边栏门控

- [x] 2.1 `Sidebar.tsx`：`NAV_BASE` 渲染时非桌面过滤掉 `/fleet` 项（保持数组数据不动、`nav-fleet` testid 桌面端不变）；同文件 `CAN_PICK_NATIVE` 可改引共享常量（可选，避免重复定义）

## 3. 舰队页降级

- [x] 3.1 `FleetPage.tsx`：非桌面渲染 `fleet-desktop-only` 说明块（一段解释 + appCatalog 桌面 App 引导），两个读区与轮询 useEffect 全部 `IS_DESKTOP` 门控

## 4. e2e + 收口

- [x] 4.1 e2e：浏览器态 `nav-fleet` count=0；直达 `/fleet` 见 `fleet-desktop-only` 且无 live 读区
- [x] 4.2 typecheck / biome / `check:locales` 绿（如需新文案 key ×5 locale）
- [x] 4.3 相关既有 spec 无回归
