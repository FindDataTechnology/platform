# Tasks — ciyuan-account-lane

## 1. 后端：词元账号凭据模块与路由

- [x] 1.1 新建 `ciyuan-account-credentials.js`（per-identity 存储：key、keyId、keyName、group、mintedAt、ciyuanEmailMasked、stale；`store/status/liveToken/markStale/remove`；投影字段白名单）。验证：`node --test scripts/test-ciyuan-account.mjs` 的存储/投影用例绿，`JSON.stringify(status())` 不含 `sk-`
- [x] 1.2 新建 `server/routes/ciyuan-account.js`：`POST /api/ciyuan-account/connect`（login→mint→store→重写，10s 超时×2，错误分类直通可读文案，password/token 用后即弃且日志脱敏）、`GET /api/ciyuan-account/connection`（投影）、`POST /api/ciyuan-account/test`（GET `/v1/models` 探针：200 connected / 401 stale / 网络不动）、`DELETE /api/ciyuan-account`（remove + 重写）；`CIYUAN_API_BASE`、`CIYUAN_MINT_GROUP_ID` 读 env 带默认。验证：假词元服务（本地 http 桩）下 connect 成功 → 词元桩收到 name 形如 `yizuo-<8hex>-<yyyymmdd>`、group_id=3；登录 401/铸键 500/网络错三类各一断言；服务端捕获日志不含密码与 token
- [x] 1.3 注册路由到 app，与 `/api/connections` 同鉴权（auth off = 机器所有者）。验证：匿名在 authEnabled 下 401

## 2. 后端：模型车道覆盖与 wanxing-caller 优先级

- [x] 2.1 `dsh-profile.js ensureCredentialsStore`：在用户 provider refs 与 prune 之后加第三层——`opts.cellOwnerEmail ?? ctx.cellUserEmail` 有值且该身份有绑定 key 时 `doc.refs.LLM_PROVIDER_KEY_FINDDATA = key`；无 cellOwner 时跳过（单进程守卫）。验证：单测用临时 dshHome：绑定后文件含用户 key、断开后回落种子值、无 owner 时文件不变；文件仍满足单行引号不变量（复用 credential-file-format 既有断言）
- [x] 2.2 绑定/断开/置 stale 后调用凭据重写 + llm profile 重载（沿 `reloadLlmProviders` 路径），并广播。验证：单测断言重写被调用一次且顺序在 store 之后
- [x] 2.3 `credential-refs.js`：wanxing-caller 项 `liveToken` 改为 `ciyuanAccount.liveToken(email) ?? lineCredentials.liveToken(email,"wanxing-caller")`，`markInvalid` 对活跃来源置 stale；`KNOWN_CONNECT_PANELS` 的 `wanxing-caller` → `ciyuan-account`。验证：单测两源优先级三组（仅账号/仅手贴/两者）+ 401 翻面
- [x] 2.4 `server/routes/misc.js /api/connections`：`line-wanxing-caller` 条目替换为 `ciyuan-account`（名「萬星·词元」，state 来自新模块），其余不变。验证：e2e connections.spec id 集断言绿

## 3. 前端：词元账号卡与接线

- [x] 3.1 新建 `CiyuanAccountConnectPanel.tsx`：未连接态=邮箱+密码表单（密码 input type=password、提交后清空）+「已有调用键？粘贴」次级入口（复用 `POST /api/lines/wanxing-caller/credential`）；已连接态=状态行（keyName、mintedAt）+「测试连接」「断开」；stale 态=「需重连」+ 重走绑定；单进程形态加说明行；断开后提示词元侧吊销。testid：`ciyuan-account-card`、`ciyuan-account-connect`、`ciyuan-account-test`、`ciyuan-account-disconnect`、`ciyuan-account-state[data-state]`、`ciyuan-account-paste`。验证：e2e 5.3
- [x] 3.2 `ConnectionsSection.tsx`：新卡置于谦面卡之前（品牌序：萬星·词元首位）+ `CardAnchor ids=["ciyuan-account"]`；panel 匹配表加别名 `line-wanxing-caller → ciyuan-account`；`LineOpsConnectPanel.tsx` 去掉 Caller 行。验证：e2e `?panel=ciyuan-account` 与 `?panel=line-wanxing-caller` 均高亮新卡；LineOps 卡只剩两行
- [x] 3.3 `web/src/lib/appCatalog.ts`：`APP_CONNECTIONS["wanxing-token"] = ["ciyuan-account"]`；`ConnectionId` 联合类型替换 id。验证：`test-app-center.mjs` 已知 id 集更新后 13/13 绿
- [x] 3.4 五语 locale：`settings.ciyuanAccount.*`（标题/副标题含优先级说明/表单/状态/测试/断开/吊销提示/单进程说明/粘贴入口）；品牌速查「萬星·词元」描述补「绑定账号后模型按你的额度计费」。验证：`npm run check:locales` 绿

## 4. 测试

- [x] 4.1 `scripts/test-ciyuan-account.mjs`：假词元 http 桩（login/keys/models 三端点可编程响应）覆盖 1.1/1.2/2.1/2.3 的全部验证点 + 「密码与 token 不出现在任何日志/存储」的 grep 断言。验证：`node --test` 绿
- [x] 4.2 `e2e/connections.spec.js`：id 集 `line-wanxing-caller`→`ciyuan-account`；新卡渲染；两 panel 值高亮。验证：fast 绿
- [x] 4.3 `e2e/app-center.spec.js`：mock 中 `line-wanxing-caller`→`ciyuan-account`；新增「`ciyuan-account` connected → `wanxing-token` 卡 connected 且无去连接」；去连接落 `panel=ciyuan-account`。验证：fast 绿
- [x] 4.4 新 `e2e/ciyuan-account.spec.js`：`page.route` 假词元端点——connect 成功→卡 connected→`/api/connections` 翻面→应用中心词元卡翻绿；test 401→stale→徽章需重连；disconnect→disconnected；登录错→可读错误且状态不变；粘贴入口贴 `sk-`→connected。验证：fast 绿

## 5. 本地验证门

- [x] 5.1 `npm run test:unit`、`npm run typecheck`、`npm run lint`、`npm run check:locales` 全绿。验证：四命令退出 0
- [x] 5.2 `npm run web:build:e2e` 后 `npx playwright test e2e/ciyuan-account.spec.js e2e/connections.spec.js e2e/app-center.spec.js --project=fast` 全绿。验证：三 spec 全绿

## 6. 发布与真机验收

- [x] 6.1 提交只 `git add` 本变更文件（勿 `-A`），双推。验证：`git show --stat HEAD` 只含本变更文件
- [x] 6.2 `fd-build-channel` → 公开快照线（**产完快照先 `ls .github/workflows`，手动修剪到只剩 image.yml**）→ run 绿 → relay OK 日志行 → ccr digest → 双清单滚 tag → ArgoCD → 双 rollout 绿 → pod imageID 全等。验证：台账证据链逐项有值
- [x] 6.3 生产真机 `scripts/verify-live-ciyuan-account.mjs`（真 Logto 账号 + 词元 trial 账号 `ciyuan-trial@findmail.com`）：bind → `/api/connections ciyuan-account=connected` → 应用中心词元卡 `connected` → pod 内 cell `.credentials.yaml` 的 `LLM_PROVIDER_KEY_FINDDATA` 为新 key（只比对前缀与长度，不打印）→ 发一句聊天 → 词元 `usage_logs` 该 key 有新行（计费主体=trial）→ test 200 → disconnect → 文件回落种子 → 徽章回未连接；词元侧 `api_keys` 出现 `yizuo-*` 新行。验证：脚本 ALL PASS
- [ ] 6.4 台账 §12.16 + 核销本 tasks + `openspec validate ciyuan-account-lane --strict` 绿 → 归档 + 五份 spec 同步（`ciyuan-account` 新主 spec 带 Purpose）。验证：归档目录存在；主 spec `connection-center` id 集含 `ciyuan-account`、`app-center` 映射已改、`line-credentials` 两要求已改、`dsh-llm-providers` 新要求在位
