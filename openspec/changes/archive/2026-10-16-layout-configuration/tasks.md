# Tasks: layout-configuration

## 1. 注册表与解析内核

- [x] 1.1 `packages/core` 落面注册表（三容器全量条目+谓词+身份元数据；Sidebar/sections/AgentsPage 三处硬编码清单迁入）
- [x] 1.2 预设 schema 与两套出厂预设（standard-snapshot 按代码现状逐项对齐；simple 骨架）
- [x] 1.3 解析函数（factory⊕deployment⊕role⊕user 收窄 + deploymentHidden 终局 + 谓词/adminOnly 终检 + 顺序取最具体层）+ 脏数据降级
- [x] 1.4 解析单测全矩阵（层组合×终局×谓词×顺序×脏数据）

## 2. 存储与 REST

- [x] 2.1 部署层存储：本地 `deployment_config` 键 + gateway 侧 store（镜像 role-system D1）；env 三种子与 stored>env 解析序
- [x] 2.2 `GET/PUT /api/layout/config`（admin；校验预设名/slug/容器，非法 4xx 不落库；非 admin 403）
- [x] 2.3 `GET/PUT/DELETE /api/layout/preferences`（self；DELETE 清除恢复继承）
- [x] 2.4 `GET /api/config` 增 `resolvedLayout`（服务端按当前用户角色+部署+偏好一次算清）

## 3. 前端

- [x] 3.1 `useAppConfig` 扩 `resolvedLayout`；三处渲染改造（Sidebar 过滤排序 / SettingsDialog 分节 / AgentsPage 页签），旧 config 缺字段回落工厂预设
- [x] 3.2 `sections.ts` 注册 `layout` 分节（Management 组、adminOnly）+ `LayoutSection` 组件（默认预设选择、按角色指定预设、部署隐藏开关；写 PUT config 即时生效）
- [x] 3.3 "工作面定制"面板：侧边栏底部入口 + 可见面开关/拖序 + 恢复按钮（走 preferences REST）
- [x] 3.4 五语言 locale（zh-CN 先行）：分节名、面板文案、预设名；`npm run check:locales` 绿

## 4. 测试与验收

- [x] 4.1 e2e：工厂基线——全新数据目录，导航/设置/页签与主分支快照逐项一致（存量 e2e 零改动全绿）
- [x] 4.2 e2e：admin 切部署默认 simple → 下次 config 读取导航 4 项、设置 4 节；无重启
- [x] 4.3 e2e：部署隐藏终局——藏 tasks 后用户定制面板不含该项、resolvedLayout 不含 tasks
- [x] 4.4 e2e：用户微调隐藏 Apps 仅影响本人；恢复按钮回到继承布局
- [x] 4.5 e2e：非 admin 直访 `/settings/layout` 回落 General、PUT 403
- [x] 4.6 `openspec validate layout-configuration --strict` 绿（依赖：role-system 已 apply）
