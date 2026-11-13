# 壹座→柏讯/lex 线需求：市场条目补 lex 凭据声明（解锁 lex 箱测） + consent 资产复核（P2 收口）

> **状态（2026-10-25 晚，柏讯/lex 侧回报，两件全收）**
> ①**已落地**——活栈（cheap-8 k8s，即公网 `mcp.finddatatech.cloud` 实际后端）`/lex-ops-mcp` 条目
> `metadata.credential_ref: "lex"` 已挂，连同 surface 名单表（commercial 6/internal 2）与工具面快照
> （8，PUT 全量体回填）一并恢复；壹座**可跑三条箱测**。同批还修复了七条同类漂移
> （wire-ops/wire-build/sentiment/quant/text-core/wanxing-ops 的 surface 名单表 + law-bench 陈名单
> 19→21），并给 `export_surface_commercial.py`/`reconcile_mcp_registry.py` 加了 manifest 单一源派生
> 与 metadata 在位巡检（首跑即抓出 wanxing 漏网条，终跑零漂移）——明细见 finddata
> `MCP-REGISTRY.md` §0「2026-10-25 对账条目」。
> ②**已销案（双方可关）**——资产供给实核无故障：`Dyvh6LUv` 为 2026-07-30 重建前旧构建残影 hash，
> 当前构建 9 资产公网全 200、部署内 0 命中、无页面引用；且当日以**全新账号真机走查**收口
> （p2walk1025：登录页完整渲染→consent 服务端自动授权→Grant 180 天即时落库→控制台首登自动开户
> free 客户+密钥，全程无白页/无 404/无 consent 页）——证据在 finddata `INFRA-NOTES.md`
> 「Logto consent/资产定案（2026-10-25）」。方案 a 的「修资产源」为空操作。
> ③tester2 占位行销账已知悉，本侧无动作。

> **箱测回填（2026-10-25 当日，三测全过，两件全部销案）**：
> ①**Test1 正例 ✅**——aloadtree（仅 lex 凭据、registry 凭据已过期）装 lex-ops-mcp → HTTP 200，
> 落库配置 `credentialRef:"lex"`（占位头被剥，系统接管）；声明已被安装闸读取生效。
> ②**Test2 负例 ✅**——lex token 过期/行 stale 态装同条目 → 409 credential-required +
> **「connect your lex line first — no live lex credential」**（lex 专属文案，非旧 registry 误导文案）
> + `ref:"lex"` + connectPath `panel=line-lex`。
> ③**Test3 零回归 ✅**——同账号装普通 registry 条目（fd-quant）→ 409 原文案
> 「connect the MCP market first」+ `ref:"registry"` ——五既有 ref 的闸行为不变。
> 附带：装机/卸载均触发 `[mcp-delivery] restarted (attempt 1)`（交付确定性第三生产实证）。
> 过程数据点（机理台账增量）：浏览器铸币后登出铸币会话 → lex 链首刷 invalid_grant → 续期网
> 诚实标 stale（**expiresWithSession 会话绑定的第三次活体实证**，与前两次重铸杀链同机理）；
> headless 平台 mint 通道重铸（不登出）即恢复。壹座侧无遗留。

> 来源：壹座 change `fix-wire-install-gate-and-credential-delivery`（wire 配套四件）上产与真机验收
> 完成后（2026-10-25，sha-055def5），唯一遗留的跨线项。
> 对象：柏讯（wire）侧市场登记通道 + lex（识律）线登记面 + Logto 租户资产。
> 状态：**无紧急故障**。P0/P1 已全部闭环并真机验收（见台账 §15.28），本档只剩两件收口件 +
> 销账备案。
> 配套：壹座台账 `docs/registry-maintenance.md` §15.28；验收记录
> `openspec/changes/fix-wire-install-gate-and-credential-delivery/tasks.md` §4.2。

## TL;DR（可直接贴群）

wire 四件配套（P0 安装闸 / P1 fleet 审计 / P1 首连交付 / P2 探针）壹座已全部上产并真机验收：
客户车道原样打通（aloadtree 零 registry 凭据装柏讯产物构建 v2 成功）、事故重放秒级交付无重启、
fleet_row_audit 生产首行归因在案、tester2 占位 registry 凭据行已撤。**剩两件球在贵侧**：
①市场条目 `lex-ops-mcp` 未声明 `metadata.credential_ref: lex`——仅 lex 凭据（无 registry 凭据）
的客户装不了它，与 wire P0 同病，但修法是**登记侧一行元数据**（壹座闸代码已备好，零代码改动）；
②consent 资产（P2）：壹座清会话探针实测**未复现坏页**（koaAutoConsent 自动授权，consent 页
不出现），但口径有缺口（存量用户非全新用户、注册流未测）——请贵侧确认资产状态或补一次全新
账号首登走查。**请柏讯/lex：①给 lex-ops-mcp 条目补 `metadata.credential_ref: "lex"`；②P2
资产修/核（方案 a 优先）；③知会 tester2 占位行销账（壹座已执行）。**

## 一、已闭环的事实（壹座侧，全部有生产证据）

| 项 | 结果 | 证据 |
|---|---|---|
| P0 安装闸 | ✅ 负例+正例 | tester2 断线装 pack → 409/credential-required + 新文案「connect your wire line first」+ connectPath 指 wire 线卡（占位 registry 行在场=旧代码必放行的对照）；aloadtree（零活 registry 凭据）装 SWPvacoFTftfVngMMFotwQ v2 → wire-build-mcp installed |
| P1 首连交付 | ✅ 事故重放 | DELETE 行 → `omitting 3 wire-customer MCP server(s)` → PASTE 首行 → `credential line created` + `[mcp-delivery] restarted (attempt 1)`，pod 不重启、秒级 |
| P1 fleet 审计 | ✅ 生产首行 | fleet_row_audit `{actor: platform-test@…, via: PATCH /api/fleets/…, changed_columns: []}`；复位复发即可定位（进程外裸写=actor NULL） |
| 1.2 身份别名 | ✅ 排除 | 两 cell 凭据行 owner 与 omitting 日志 owner 逐字一致 |
| P2 探针 | ✅ 未复现 | 清 Logto 会话 → wire 控制台登录全程无 consent 页/白页/404（见 §三） |
| wire 配合项 | ✅ 销账 | tester2 占位 registry 凭据行已撤（10-25，paas 经 API 执行），tester2 回到真实新客户态 |

镜像：sha-055def5（paas b4b2a12e + 6618e3fa，digest 9292d3fa），10-25 晨上产。

## 二、需要柏讯/lex 做的两件事

### 2.1 lex-ops-mcp 市场条目补凭据声明（P0 同病收口，登记侧一行）

**现状**：壹座市场里 `lex-ops-mcp` 条目（registry 来源，`https://mcp.finddatatech.cloud/lex-ops-mcp/mcp`）
**未声明** `metadata.credential_ref`。壹座安装闸的派发顺序是：条目声明的 `credential_ref` →
wire 工具面快照（只覆盖 wire 系服务器，派发 wire-customer）→ 兜底 registry 凭据。lex-ops-mcp
两不沾 → 落 registry 闸 → **只有 lex 凭据、没有 registry 凭据的真实 lex 客户装不了它**，409 文案
还会误导成「connect the MCP market first」——与 wire P0 逐字同病，只是换了条线。

**修法（贵侧，零壹座代码）**：登记通道给该条目的 metadata 补：

```
metadata.credential_ref: "lex"
```

（registry-bridge 会把它映射为 entry.credentialRef，壹座安装闸自动改用 lex 凭据判活。）
壹座侧判活/文案/connectPath 已在 10-25 的表驱动改造里备好（`credential-refs.js` REFS 表
lex 条目：connected/missingReason「connect your lex line first — no live lex credential」/
connectPath `panel=line-lex`）——声明一落，闸即生效，无需壹座发版。

**声明上产后壹座跑的箱测（验收口径，壹座执行）**：

1. 仅 lex 凭据（无活 registry 凭据）账号装 lex-ops-mcp（市场卡安装）→ 成功，装出的配置
   credentialRef=lex；
2. 断开 lex 凭据再装 → 409 credential-required + lex 专属文案 + connectPath 指 lex 连接卡；
3. wire/facet-market/chatwoot/paper-trading/registry 五既有 ref 装行为零回归。

### 2.2 consent 资产复核（P2 收口，建议 + 备选实弹）

**壹座探针结果（10-25）**：清 Logto 会话（logout + end_session）→ wire 控制台登录（aloadtree，
fresh session）→ **全程无 consent 页、无白页、无 404**，直接进入内部后台。交接单预判的「新会话
首登卡 consent 坏页」未复现——koaAutoConsent 对一方 client 的自动授权让 consent 页根本不出现。
P2 的「定时炸弹」要么已被贵侧修掉、要么原判断过虑。

**口径缺口（为何还不能直接销案）**：

1. 探针用的是**存量用户**（aloadtree，账号存在、只缺该 client 的 Grant），不是「从未登录过的
   全新用户」——新用户走注册流，Logto 侧页面组成可能不同；
2. 未核资产本身：`assets/index-Dyvh6LUv.js` 三处 404 是否已被修复，只有贵侧 Logto/wire 侧
   能查（sign-in-experience 的 /assets 供给源）。

**请贵侧二选一**：

- **a（推荐）**：查一眼 sign-in-experience 资产供给是否已修；若仍 404，按原方案修资产源
  （不要走「批量补 Grant + 无 UI consent」的治标线——资产坏了别的面还会踩）；
- **b**：用一个全新账号做一次完整首登走查（注册 → 登录 → 控制台），把 P2 原验收口径跑完；
  若全程无白页/404，P2 即可双方销案。

## 三、备案（贵侧知会即可，无动作）

1. **观测口径更新**：10-25 浏览器走查给 aloadtree 铸了**新的 lex 链**（走查刻意选 lex 线避让
   wire-customer 观测主体）——lex 观测计时自 10-25 重置；新行走平台 mint 通道、带 rotator，
   链完整。wire-customer 四链未动（走查后 18:00Z 照常续期）。§15.27 的观测期纪律
   （至 10-31 勿手工重铸）对 wire-customer 链继续有效。
2. **tester2 占位行销账**：fd-wire HANDOFF 遗留 #3 可关——壹座已撤（`DELETE
   /api/registry/connection`），tester2 现为真实新客户态（无线凭据、无 registry 凭据、pack 未装），
   下次真实登录铸币即走修复后的完整客户车道，正好是 P0 的天然回归位。
3. **AI_CELL_ENDPOINT_MAP 开户口径**：已在位（GitOps bcf57e3），无新 ask。

## 四、回报口径

完成后在本档头部标状态即可（壹座台账 §15.28 ③④同步销账）。lex 声明落库后告知壹座，箱测
当日跑完回填双方台账。
