# Tasks — add-facet-cli-update（F2.3）

- [x] 1.1 install 落记录（installed.json，FACET_HOME 随动；同包同 target 重装=原地更新）
- [x] 1.2 update 子命令（全量/单包/--target；已最新/升级/404 三态输出；零订阅副作用）
- [x] 1.3 help+版本 0.2.2；单测（stub 面：记录合并+三态）
- [ ] 2.1 npm 发布（**挂起**：org GHA 账单阻断——账单恢复 dispatch 或 npm 网页 staged publish；CLI 仓库内可用）
- [x] 2.2 归档+路线图 F2.3 ✅

## 验收实证（2026-10-12）

- 单测 3 例绿（记录写入/复合键去重/三态：已最新 no-op、v1→v3 技能重写+记录更新、
  失联包诚实续跑；--target 显式过滤语义）。v0.2.2。
- 生产真跑：node facet/cli/facet.js update（本机 F2.1 装的七技能家底）——已最新
  no-op 全绿。
- npm 发布**挂起**：org GHA 账单阻断（run 38272878982 实锤）。解锁二选一：账单
  恢复后 dispatch facet-cli-publish.yml；或 npm 网页 staged publish（用户一次
  密钥触控）。仓库内 CLI 即时可用（node facet.js update）。
