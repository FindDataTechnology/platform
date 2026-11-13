# Tasks: add-facet-version-history

## 1. 后端契约：notes 字段校验

- [x] 1.1 发布门（`gateway/packs.js`）加 `notes` 校验：可选、string、≤500 字，违例以机器可读 reason 拒绝；单测覆盖三条（超限拒/非 string 拒/缺省照常过）——`npm test` 对应套件绿
- [x] 1.2 cell 安装路径的镜像校验同步加同规则（定位与发布门共享/镜像的 manifest 校验点），单测同三条覆盖——双验证器各一套绿
- [x] 1.3 手工冒烟：带合法 notes 的 manifest 走 `#/mine` publish-from-manifest 发布成功，`GET /api/packs/:id/versions` 行与 `/:v` manifest 均携带 notes

## 2. 共享版本列表组件

- [x] 2.1 壹座树新建共享组件（`web/src/components/packs/`）：懒加载披露（打开才调 `listPackVersions`）、行内 版本号/发布时间/发布者/note-when-present、逐版 manifest 与技能链接；组件测试覆盖懒触发与行渲染
- [x] 2.2 新 UI 文案五语齐（壹座与谦面 locale 副本都落），`node scripts/check-locales.js`（或等价门）通过

## 3. 三面集成

- [x] 3.1 `PackDetailDialog` 挂披露区（默认折叠，不进默认载荷），壹座+谦面市场 detail 双面可见——本地起两壳目检 + 组件测试
- [x] 3.2 `MineView.tsx` 本地版本行替换为共享组件（删 `toggleVersions` 本地实现），`#/mine` 行为不回退（展开/收起/错误态仍在）
- [x] 3.3 一键发布确认步加可选版本说明输入（空=manifest 不带 `notes` 字段），发布后版本行可见该说明

## 4. e2e 与收尾

- [x] 4.1 壹座市场 e2e：匿名打开公共包 detail→展开版本历史→断言懒加载请求发出、行渲染（含 notes）、逐版链接可达；私有包版本历史对匿名不可达
- [x] 4.2 谦面壳哨兵 e2e：`#/packs` detail 版本披露 + `#/mine` 共享组件渲染两断言过
- [x] 4.3 CI 全绿（lint/unit/build + e2e 走 CI 既定线）；生产实证按 paas-release 标准线出证后归档
