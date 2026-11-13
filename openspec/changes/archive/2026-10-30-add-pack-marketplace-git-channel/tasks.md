## 1. 收录口径单源（D2）—— 已完成

- [x] 1.1 把 `facet/marketplace-json.js` 里的 `loadListed` 提到模块级并导出为 `loadListedPacks`
  （端点 `registerMarketplaceJson` 改为调用同一函数，行为字节级不变；同时导出 `curatedPackIds` 便于测试）；
  验证：既有 Claude 端点测试 `test-facet-marketplace-json` 5/5 绿，策展 / 白名单覆写 / unlisted 三态不变
- [x] 1.2 跨面一致性测试：同一 registry 夹具下「仓库清单集合 == 端点清单集合」——
  既做了函数级（`loadListedPacks` 直比），也做了 **HTTP 级**（真起 express 端点取 `/api/marketplace/marketplace.json`
  与仓库清单对拍）；验证：`test-facet-marketplace-repo` 里两条用例绿，白名单空/非空两态都覆盖

## 2. 仓库投影模块（D3/D4/D7）—— 已完成

- [x] 2.1 新增 `facet/marketplace-repo.js`：生成根 `.codebuddy-plugin/marketplace.json` 与每包
  `plugins/<packId>/`（`.codebuddy-plugin/plugin.json`、`skills/<skill>/SKILL.md` + 辅助文件、`agents/*.md`、
  连接指引 README）；验证：单测断言清单字段（name/owner/plugins[].name/source/description/version）与
  文件树逐项相等
- [x] 2.2 路径与限额复用 `lib/skill-files.js` 的 `safePackagePath`；验证：单测覆盖绝对路径、`..` 段、盘符、NUL
  四类输入**均被拒绝**（`UNSAFE_PATH`/`BAD_SEGMENT`，不是清洗），且拒绝时不产出任何部分目录
- [x] 2.3 快照自检闸 `validateMarketplaceRepo`：清单可解析、每个条目目录存在、无路径逃逸、条目不重复，
  以及**反向断言**（仓内插件目录必须全部在册）；验证：单测构造缺目录 / 孤儿目录 / 坏清单 / 重复条目四态，
  断言 `SNAPSHOT_INVALID` 且分类正确
- [x] 2.4 插件本体不含 MCP 服务器配置与任何凭据：验证：单测断言 `plugin.json` 无 `mcpServers` 键、
  全树任何文件都不出现 `"mcpServers":` 配置片段，且 README 含端点与组要求；另有凭据扫描用例
  （内容含 `wgk-…` → `CREDENTIAL_IN_CONTENT` 拒绝导出）

## 3. 生成与推送（D5/D6）—— 已完成

- [x] 3.1 新增 `scripts/export-marketplace-repo.mjs`：`--out <dir>` 生成、`--push` 推送、`--dry-run` 零写盘、
  `--db <packs.db>` 指定注册表；内容无变化时不产生提交；验证：端到端用例连续两次运行断言第二次无新提交且退出码 0
- [x] 3.2 失败即保留 last-good：验证：端到端用例注入一个含凭据形态的包后运行，退出码 1、
  `marketplace.json` 与运行前**逐字节相同**、`git status` 干净
- [x] 3.3 推送凭据只从 git remote 自身配置/环境读取、脚本不接触凭据；验证：端到端用本地 bare 仓模拟远端，
  `--push` 成功且幂等（连推两次均退出码 0）；脚本体内无任何凭据读取

## 4. 文档 —— 已完成

- [x] 4.1 运维文档补「刷新市场仓」动作与时效上界：`docs/registry-maintenance.md` 新增
  「WorkBuddy / CodeBuddy 市场仓通道」节（刷新命令、收录口径、时效、last-good、下架边界、三个已抓真缺陷）；
  验证：该节可被运行表检索到
- [x] 4.2 用户指南补「用市场仓安装」：新增 `docs/ecosystem/workbuddy-marketplace.md`（添加地址 → 浏览 →
  安装 → 更新 → 下架语义 → 常见问题 → 出处）；验证：`node --test scripts/test-facet-docs-facts.mjs` 仍 7/7 绿

## 5. 真机验收

- [x] 5.0 产物结构与客户端已装市场**逐字段对拍**：本机 WorkBuddy 5.9.3 的两个市场
  （`workbuddy-wecom-unified`、`codebuddy-plugins-official` 206 条）均为
  `<root>/.codebuddy-plugin/marketplace.json` + `plugins/<name>/.codebuddy-plugin/plugin.json`；
  顶层键（`name`/`owner`/`plugins`，官方无顶层 `version`）、条目键（`name`/`source`/`version`/`description`）
  与我们一致；`plugin.json` 的 `name`+`version` 必须与条目一致（客户端加载器原文
  `plugin.json of <name> disagrees with marketplace.json` 直接 reject）；带技能的插件显式声明
  `"skills": ["./skills"]` —— **已据实补齐**并有单测钉住
- [ ] 5.1 在真实 WorkBuddy 客户端「插件 → + → 输入市场地址」添加该仓；验证：市场出现在列表且可浏览
  （**远端仓已上线**：`FindDataTechnology/facet-marketplace`（公开 GitHub，2026-10-30 自生产
  packs.db 投影 75 功能集/509 文件，`--push` 成功）。清洁 HTTPS 克隆机检：marketplace.json
  `name=facet`/owner/75 条目、60 条带 `skills:["./skills"]`+SKILL.md、plugin.json 与条目
  name+version 全一致、键形状泄漏扫描零命中。客户端 `parseSource` 代码级确认
  `owner/repo`→GitHub 源、https→Git 源。剩「插件→+→输入地址」一键浏览属真机 UI 步——
  模拟注册（写 known_marketplaces.json+物化克隆）试过一轮：目录为惰性加载，日志无 facet
  证据即回滚（不留污染状态），故此项保持未勾，配方已写入 `docs/ecosystem/workbuddy-marketplace.md`）
- [ ] 5.2 安装一个带技能的插件；验证：技能出现在「已安装」且对话中可被调用，无"路径未找到"错误
  （依赖 5.1 的真机添加；安装/物化流客户端代码路径与 5.0 对拍结构一致）
- [ ] 5.3 发一版新版本后刷新仓库再更新；验证：客户端显示新版本并可更新，旧版本仍可回退
  （重投影即 `node scripts/export-marketplace-repo.mjs --db <packs.db> --out <仓工作树> --push`，
  last-good 契约保证坏投影不落盘；更新流属真机 UI）

> 5.1–5.3 状态更新（2026-10-30 第二轮）：原「需要可访问远端仓」阻塞**已解除**——公开仓
> `FindDataTechnology/facet-marketplace` 已上线并克隆机检通过。三项的**仓侧/代码侧**证据齐；
> **UI 一键**（添加地址→浏览→安装→更新）待真机操作，保持未勾。
