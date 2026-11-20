# 在 WorkBuddy 里用市场仓安装谦面功能集

WorkBuddy（及同族的 CodeBuddy）的插件市场支持**按地址添加外部市场**。谦面出了一份 CodeBuddy 兼容的
市场仓，加进去即可浏览、安装——不需要我们进他们的官方市场（他们也没有第三方自助提交口）。

## 为什么是"仓"而不是"一个地址"

客户端官方文档写明：**URL 型市场是 catalog 分发方式**——它只取 `marketplace.json` 与相对路径条目的
`plugin.json`，**无法通过 HTTP 目录列表递归镜像任意插件文件**。所以含技能/命令/Hooks 的插件在 URL 型
市场里会"装上了但没有内容"。整仓 Git 源才能把技能文件真正带到本地。

（我们给 Claude Code 出的那个 JSON 端点仍然有效，两者并存：那个面向 `/plugin marketplace add <url>`，
这个面向"添加市场地址"要整仓的客户端。）

## 用法

1. 打开 WorkBuddy → 左侧**插件** → 市场区域右上角 `+` → 输入市场地址。
2. 谦面官方市场仓地址（公开 GitHub，免鉴权克隆）：**`FindDataTechnology/facet-marketplace`**
   （等价 HTTPS：`https://github.com/FindDataTechnology/facet-marketplace`）。客户端地址解析器
   代码级确认：`owner/repo` 形状走 GitHub 源、https 仓库 URL 走 Git 源（5.9.3 出厂 bundle `parseSource`）。
   注意该客户端的仓库地址以"包含 `.codebuddy-plugin/marketplace.json` 的仓库"为准——本仓正是该形状。
3. 添加成功后即可浏览与安装条目。可选：为该市场打开**自动更新**（第三方市场默认关闭，官方市场默认开启）。
4. 维护方（我们）：内容投影自谦面生产库——从 facet pod 取 `packs.db`
   （`kubectl --context cheap -n fd-prod cp <facet-pod>:/data/facet/packs.db …`），跑
   `node scripts/export-marketplace-repo.mjs --db <packs.db> --out <市场仓工作树> --push`；
   自检不过不落盘（last-good 契约），仓里**永不出现凭据形状字符串**（出现即上游发布闸门失守，导出器拒写）。

## 装进去之后

- **技能**：出现在「专家·技能」的「已安装」页，对话中可直接调用；每个技能是独立目录含 `SKILL.md`。
  关闭开关 ≠ 卸载（关闭只是暂停模型调用，文件仍在）。
- **智能体**：插件携带的 agents 成为可用的专属助手。
- **MCP**：**不随插件自动连接**。插件 README 给出每个引用服务的端点与组要求；连接方式是
  `--target workbuddy --write-mcp` 由谦面 CLI 写配置——今日可用的是贴键车道（`facet connect` 铸
  wgk- 键，键写进 `~/.workbuddy/mcp.json`）；另有免键前瞻条目（加 `--oauth`，只带静态 client_id、
  零凭据落盘；服务端侧 2026-10-30 端到端实证，5.9.3 客户端的用户文件加载器暂不消费该块——
  两层状态与配方见 `workbuddy.md` §1a）。
  这是刻意的：公开仓库若嵌服务器配置，没有身份的人装上去就是坏的。

## 下架的诚实边界

功能集一旦被作者 unlist 或变成私有，下一次刷新后它就从仓里消失、新用户装不到。**但已经装到用户机器上的
副本收不回来**——这是客户端把插件物化到本地的固有性质（与我们给 Claude 的插件面同一姿态）。
需要"停止分发"用 unlist；需要"召回内容"只能靠通知用户卸载。

## 刷新时效

仓不是实时的：发布、下架、改策展都只在**下一次刷新**后反映到仓里。刷新是运营动作（见运维文档），
不挂在发布请求路径上——发布接口要快，推仓要慢且要推送凭据。

## 常见问题

**添加地址报错 / 加上了但看不到条目。** 先确认地址指向的是含 `.codebuddy-plugin/marketplace.json`
的仓库根，其次确认该条目在册（公开 ∧ 非 unlisted ∧ 已策展——`category` 非空或 `featured`）。
未策展的公开包在仓里本来就不出现，这是与浏览面一致的口径。

**装上了但技能调用不到。** 到「已安装」确认技能在不在、开关是否关闭；重启会话让新技能进模型可见面。

**更新不生效。** 该市场默认不自动更新（第三方市场默认关闭自动更新），手动点该市场/该插件的「更新」，
或打开自动更新。仓内容变化才会有新版本号——运营没刷新仓时，客户端看到的就是旧的。

## 出处

- 客户端一侧：其官方文档的「插件」与「插件市场（Plugin Marketplaces）」两页（2026-10-30 核对）——
  插件组成、市场添加方式、`.codebuddy-plugin/marketplace.json` 清单形状、URL 型市场的限制、自动更新默认值。
- 谦面一侧：`facet/marketplace-repo.js`（投影与自检）+ `scripts/export-marketplace-repo.mjs`（导出与推送），
  行为由 `scripts/test-facet-marketplace-repo.mjs` 钉住（13 项，含三个端到端 git 用例与清单一致性）。

## 实证记录（2026-10-30，macOS 真机）

**已验（结构对拍）**：本机 WorkBuddy 5.9.3 已装的市场（`workbuddy-wecom-unified`、`codebuddy-plugins-official`
206 条）均为 `<root>/.codebuddy-plugin/marketplace.json` + `plugins/<name>/.codebuddy-plugin/plugin.json`。
`facet/marketplace-repo.js` 的产物与之逐字段一致：

- 顶层：`name` / `owner.name` / `plugins[]`（官方市场无顶层 `version`，我们同此）；
- 条目：`name` / `source`（相对 `./plugins/<id>`） / `version` / `description`；
- 插件清单：`name` + `version` 必须与条目**完全一致**——客户端加载器读 marketplace.json 与 plugin.json
  后会直接 reject 不一致者（其代码：`plugin.json of <name> disagrees with marketplace.json`）；
- 带技能的插件显式声明 `"skills": ["./skills"]`（客户端自带市场即如此），我们同。

**未验**：「插件 → + → 输入市场地址」的真实添加/安装/更新走查——需要一个可访问的远端 Git 仓，
本轮只在本地生成并提交（本地 bare 仓模拟远端），未对外发布。
