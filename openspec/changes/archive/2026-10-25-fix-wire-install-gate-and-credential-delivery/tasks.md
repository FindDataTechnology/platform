# Tasks — fix-wire-install-gate-and-credential-delivery

## 1. 身份键别名验证（只读，不阻塞后续）

- [x] 1.1 静态核对：读 `db.normalizeIdentityEmail` 与 line-credentials 路由 identity()
  （ssoUser 优先）→ 写入器 owner（runtimeOwnerEmail 种子/改写点）的键归一化路径，确认
  两路是否存在可分叉的 email 形态；结论记入本节下方。验证：结论有代码行号支撑。
- [x] 1.2 生产只读验证：在受影响 cell 上比对 `user_line_credentials.email`（wire-customer
  行）与 `[dsh-profile] omitting` 日志的 owner；坐实别名 → 在本 tasks 追加归一化修复任务。
  验证：比对结果记录（若生产通道不可达，明示 deferred，不静默跳过）。
  > 1.1 结论（2026-10-25）：无归一化分叉——line-credentials 路由（ssoUser 边界即
  > trim+lowercase，auth.js:313-317）与写入器判活（liveToken→ownerKey→
  > normalizeIdentityEmail，db.js:1592 同为 trim+lowercase）殊途同归；残余风险仅剩
  > 「铸币会话与 cell 绑定的 email 本串不同」（wire-tester2/wiretester2 双 slug 在
  > AI_CELL_ENDPOINT_MAP 并存为旁证）。
  > 1.2 结论（2026-10-25 上产后生产只读裁决）：**身份别名排除**——tester2 cell
  > (420a3344) 行 owner=`wire-tester2@findmail.com`、platform-test cell (3fdc7b8e) 行
  > owner=`platform-test@findmail.com`，与 `[dsh-profile] omitting` 日志 owner 串逐字
  > 一致；静态（1.1）+运行时双侧无分叉。15:1x 事故机理收敛为兜底 restart 缺口（3.1 修）。

## 2. P0 安装闸表驱动补分支

- [x] 2.1 `credential-refs.js`：REFS 的 wire-customer/lex/wanxing-caller 条目增加
  `connected(email)` 与 `missingReason` 字段；`credentialConnected` /
  `credentialMissingReason` 改为先查表、未声明字段走既有 if 链。验证：既有四 ref
  分发单测（test-facet-market-ref-dispatch）全绿。
- [x] 2.2 单测扩展：test-facet-market-ref-dispatch（或新文件）覆盖——仅 wire-customer
  凭据判活 true/无凭据 false、lex 同形、wanxing-caller 同形、四既有 ref 判活与文案
  零变化、missingReason 文案指名线。验证：`node --test` 对应文件全绿。

## 3. P1 交付兜底归控制器 + 首行审计

- [x] 3.1 `server.js` `dshUpdateMcp`：非热交换兜底分支的裸 `dshBridge.restart` 改调
  `credentialDelivery.onCredentialChange(patchPath)`（保留 patchPath===undefined 之外的
  原有条件结构）。验证：scripts/test-dsh-mcp-delivery.mjs 全绿 + 引用点代码走查。
- [x] 3.2 `line-credentials.js` `store()`：落行前查有无既有行，无 → 日志
  `[line-credentials] credential line created: <email> <line>`（无 token 材料）。
  验证：test-line-credentials.mjs 增断言首行记事件、改行不记，全绿。

## 4. 回归与验收

- [x] 4.1 本地回归：`node --test` 跑 test-facet-market-ref-dispatch / test-line-credentials
  / test-dsh-mcp-delivery / test-registry-credentials / test-paper-trading-credentials
  / test-facet-market-credentials 全绿。验证：命令输出。
- [x] 4.2 真机验收（随上产）：无 registry 凭据账号装 wire pack 成功；断开后 409 文案+
  connectPath 指线卡；lex 同形；新 cell 铸首行不重启 5min 内 tool_search 可见；清
  Logto 会话新浏览器完整铸币（consent 交叉面）；验证后 wire 侧撤 wire-tester2 占位
  registry 凭据。验证：验收记录补入本节下方。

### 4.2 验收记录（2026-10-25，sha-055def5 上产后）

- **上产**：快照 055def5 → GHA 绿 → relay OK（digest 9292d3fa）→ fd-infra-deploy 9c02b89
  → ArgoCD sync → rollout 完成，/healthz 200。
- **P0 负例**（tester2，占位 registry 行仍在场=旧代码必放行的最强对照）：断开
  wire-customer → 卸 wire-build-mcp → 装 SWPvacoFTftfVngMMFotwQ v2 → 拒装
  `credential-required` + **新文案** "connect your wire line first — no live wire
  credential" + connectPath `/settings/connections?panel=line-wire-customer` ✓（旧文案
  "connect the MCP market first" 不再出现）。
- **P0 正例**（aloadtree：registry 凭据 10-23 已过期=零活 registry 凭据、仅活
  wire-customer 行）：装同 pack → `wire-build-mcp: installed` + 双 agent installed ✓
  ——正是需求原文的客户车道场景。
- **P1 事故重放**（aloadtree，全程无平台重启，pod age 12m 恒定）：pod 内 refresh grant
  铸 ID_1 → DELETE 行（API）→ `[dsh-profile] omitting 3 wire-customer MCP server(s)
  (wire-ops, wire-build-mcp, wire-ops-mcp)` → PASTE 首行（真 API）→
  **`[line-credentials] credential line created: aloadtree@gmail.com wire-customer`** →
  **`[mcp-delivery] credential change: runtime child restarted with the fresh patch
  (attempt 1)`** ✓（秒级交付，5min 窗口内）。
- **rotator 保护**：paste 建行无 rotator，RT 窗口内（租户 TTL ~31-33min）refresh#2 取
  RT_2 直写回行（单列 UPDATE，等效续期服务写入）；链 43 字符 stale=0，7 天观测主体无损，
  明早巡线不受影响。全程只走 refresh grant（无新授权）——§15.27 定案的杀链机理
  （同 user+client 新授权）未触发。
- **lex 同形**：市场条目 `lex-ops-mcp` 未声明 `metadata.credential_ref: lex`（注册侧
  缺口，非 paas 闸缺陷）——条目派发按工具面快照只覆盖 wire 系；lex 分支由单测覆盖
  （test-facet-market-ref-dispatch 9/9），箱测待登记侧补声明后可跑。
- **consent 交叉面（2026-10-25 补，admin 凭据到位后浏览器实走）**：清 Logto 会话
  （logout + end_session）→ wire 控制台登录全程**无 consent 页/白页/404**（koaAutoConsent
  对一方 client 自动授权，consent 页不出现——P2 预判的「定时炸弹」实测未复现，升级证据
  的反面，P2 归 wire/Logto 侧继续观察）→ 平台侧 lex 线浏览器铸币全链
  mint/start→Logto→callback→`/settings/connections?panel=line-lex`（无 lineError）→
  connected:true + `[mcp-delivery] restarted (attempt 1)`（交付确定性第二生产实证）。
  走查选 lex 线系保护观测纪律：wire-customer 链是 7 天观测主体（§15.27 观测期至 10-31
  禁同 user+client 手工重铸），lex 链计时重置为已知代价；铸币用平台 mint 通道（非裸
  脚本），符合纪律修正版。aloadtree wire 链走查后 18:00Z 照常续期未受扰。
- **wire 侧配合项**：tester2 占位 registry 凭据行已撤（DELETE /api/registry/connection
  → connected:false）✓——tester2 回到真实新客户态（无线凭据、无 registry 凭据、pack
  未装），下次真实铸币即走本修复后的完整客户车道。
