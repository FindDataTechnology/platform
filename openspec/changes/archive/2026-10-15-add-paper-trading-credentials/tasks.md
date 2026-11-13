# Tasks: add-paper-trading-credentials

## 1. 存储与模块

- [x] 1.1 db.js 迁移 **v29**：`user_paper_trading_credentials`（email PK, token, stale,
      updated_at；单槽无 active——design D7）+ 访问器四件（get / set 整体替换+清
      stale / markStale / delete）；验证：迁移后 `schema_migrations` 见 v29 行且
      访问器单测过
- [x] 1.2 `paper-trading-credentials.js` 五件套：refName 字面 `"paper-trading"`、
      isRef、liveToken（stale/无行→null，否则原样返回——纯同步无续登）、markInvalid
      （置 stale 返回翻转）、staleEvent `paper_trading_credential_stale`、status 投影
      （connected/stale/updatedAt，永不含 token）；验证：模块单测 1.x 全绿 +
      投影断言无 token 材料
- [x] 1.3 `credential-refs.js` 注册第四条 ref（照 connector 行形状）；验证：
      `knownRef("paper-trading")` 为真、resolveCredentials 对带该 ref 的 server 行
      注入 Authorization 或省略

## 2. 安装链（handoff ⓪ 三处闭环，缺一不可）

- [x] 2.1 `pack-store.js` 的 `credentialConnected` 加 paper-trading 分派（修「错误按
      registry 放行」缺口）；验证：单测——paper-trading ref + 未连接凭据 → false
      （不再错走 registry 分支）
      - 实施中另发现**第二个分派点**（handoff 未列）：市场卡片直接安装路径
        `POST /api/extensions/mcp`（server/routes/extensions.js）独立硬编码判
        registry 凭据 + stamp `credentialRef:"registry"`——装 fd-paper-trading 卡片
        会把 registry 市场 token 注入柏讯服务（跨服务凭据错投）。已一并修复：
        分派函数上移 credential-refs.js（两个消费点共用），市场卡片路径改按
        `entry.metadata.credential_ref` 分派（409 拒 + stamp 各自 ref）。
        两端各有回归测试（4.2）。
- [x] 2.2 mcp.json 基线加 `paper-trading` 行：url
      `http://cheap6.mesh.finddata.cn:31894/mcp/`（**尾斜杠必须**，design D6）+
      `credentialRef: "paper-trading"`；验证：JSON 可解析、与 facet-market 行同构

## 3. 路由与面板

- [x] 3.1 `server/routes/paper-trading.js`：`GET /api/paper-trading/connection`（状态
      +serviceUrl 指路）/ `POST`（fdt_ 形状检查→probe GET `<origin>/api/v1/accounts`，
      **唯 401 硬拒**，网络失败/5xx 照存）/ `DELETE`；origin 从 mcp.json 行推导（D3
      单源）；匿名写 hosted 模式 401 门；验证：路由单测四态（200 存/401 拒/网络照存/
      匿名拒）
- [x] 3.2 server.js 挂载路由；验证：路由测试 GET 200 未连接投影 + 三端点全链（4.1 测试文件内）
- [x] 3.3 web `PaperTradingConnectPanel.tsx`（照 ConnectorConnectPanel 裁剪：粘贴框+
      状态+断开）挂 McpMarketView 市场头；i18n **五语一次做齐**（en/zh-CN/ja/es/fr，
      不留 fallback 债）；验证：typecheck 零新错（web+core 均 0）+ 五语文件条目在位
      （check-locales 五语 1275 key 全等）+ 面板渲染 e2e 绿（extensions.spec 20/20）
      + web build 成功

## 4. 测试

- [x] 4.1 模块单测（scripts/test-paper-trading-credentials.mjs）：refName 字面断言、
      存取/替换清 stale、markInvalid 恰一次翻转、liveToken stale→null、投影无 token；
      16/16 全绿
- [x] 4.2 pack-store 分派单测：`credentialRefForEntry`（metadata.credential_ref=
      paper-trading）+ `credentialConnected` 三分派 + **装包全链与市场卡片安装全链
      各一条**（未连接 409 credential-required + 拒因指路 + 无死行；已连接装为
      paper-trading ref）；scripts/test-paper-trading-credentials.mjs 16/16 绿
- [x] 4.3 全量单测回归：新失败为零（树上预存失败基线另册，不混入）
      —— `npm run test:unit` 1303/1304；唯一失败 test-harness-adapter 的
      [acp] session/cancel 系负载下时序 flake（单跑 3/3 过、整文件 18/18 过、
      与该测试零引用交集），非本 change 回归

## 5. 上线验收（handoff 定义的 done，四条全过才算）

- [x] 5.1 出片（GHA→hkccr→relay→ccr 纪律）+ 三 deployment 同滚 + configmap
      paper-trading 行走 **GitOps** 落库（带外 apply 会被 selfHeal 打回——facet-market
      前车之鉴）；验证：生产 mcp.json 含该行、schema v29、路由 401 门在位
      - 判路 fd-build-channel：公开仓免费线（scs001/platform-image-verify，零成本）
      - 出片 46999e1 绿（含 image.yml 恢复提交——scrubber 同名坑复现，按既有配方收窄
        到只剩 image.yml 再推）；relay 回灌 ccr 实证（`sha-46999e1 OK`）+ skopeo
        硬门（digest 9a5856c5）
      - **五清单同滚** sha-46999e1（agent-runner-b/c+facet+platform+platform-demo）；
        GitOps 双推 gitee+github → ArgoCD hard-refresh → 五 deployment 全 READY
      - 生产实证：cell schema v29（表四列）、configmap 行在位、路由匿名 401、
        `[dsh-profile] omitting 1 paper-trading MCP server(s) — no live credential`
        （fail-closed 省略语义生产可见）、服务 mesh 自检 200
- [x] 5.2 生产四验收：①两个壹座用户各 paste 各的 `fdt_` token 装包
      `DydB2cal-M9l91IMJYHshA` 成功且 server 行带 credentialRef: "paper-trading"
      ②两用户 `list_accounts` 各见各的账户 ③用户 A 吊销 token→401→stale→server 从
      A 的 profile 消失+WS 事件到达，B 不受影响 ④未连接凭据用户装包被 409 拒（指路
      文案在位）；四条各有实证记录
      - **2026-10-15 生产等价实证（②③ 服务级+注入链）**：铸两枚真 fdt_ token——
        ①A 建模拟账户后 A token 见 1 条/B 见 0 条（逐用户隔离）②生产进程内真模块链：
        store→cell 库 v29→resolveCredentials 注入真 Bearer→**注入 token 直调服务 200
        （accounts=1）**→markInvalid 恰一次→注入翻 OMITTED（fail-closed）③吊销 A
        token→401（dsh-events 翻面信号）；B 不受影响④两测试 token 均已吊销清理
      - **①浏览器全链眼见（ego-browser，platform.finddatatech.cloud，真实用户身份
        vaas-trial@findmail.com）**：商店页四卡列首位眼见（柏讯·模拟交易/未连接/
        fdt_ 指路/打开服务→，五语中文版）→粘贴 token→面板翻「已连接 更新于」→
        cell 库行落（时间戳与面板吻合）→**dsh profile 注入 `mcp-paper-trading`
        （mesh URL 带尾斜杠 + Authorization: Bearer 真 token）**→MCP 握手
        initialize（服务自证 fd-paper-trading v3.4.5）+tools/list **19 工具全可见**+
        `list_accounts` 真调用返回自己账户（$100,000）。验收后清理：token 吊销
        （401 复核）+库行删除+profile 重写（paper-trading 行省略，fail-closed 再现）
      - ④ 装包 409 的 UI 侧：单测全链已盖（拒因含 ref 指路）；未连接态面板
        「未连接+指路」眼见（上）；真装包（pack DydB2cal）受组门 wire-customers
        辖制（对方侧授权），属跨系统依赖

## 6. 对账回填

- [x] 6.1 台账回填：`LINES-MCP-CONFORMANCE.md` 壹座侧各线 key 表加 paper-trading
      ref 行（照 facet-market 行形状）；finddata 侧 handoff（任务 3.3/3.4）回执对方
      change
      - paas 侧：`docs/yizuo-platform-roadmap.md` C3 节追加生产上线记录（d161053/
        sha-46999e1 五滚/等价实证/组门遗留），提交 7c9ef96
      - finddata 侧：`LINES-MCP-CONFORMANCE.md` 两处更新（①柏讯模拟交易 `fdt_`
        key 形状加入各线 key 表 ②既有注册位补第四轨 `paper-trading` + 安装分派
        说明）；回执 `paper-trading-facet-pack/reports/paas-credential-ref-done.md`
        （四件活逐项对照+第二分派点发现+验收实证表+对方侧遗留三条）
