# fix-wire-install-gate-and-credential-delivery

## Why

wire 线真实客户装不了任何 wire pack：安装闸把 wire-customer/lex 凭据 ref 的连通性检查
fall-through 到 registry 凭据——wire-tester2（basic 档）装「柏讯·产物构建」v2 被 409
credential-required 拒装，同期该号的 wire-customer 凭据明明 connected:true；塞一条占位
registry 凭据后立即放行，证明闸查错了凭据（运营号 platform-test 能装只因恰有一条 sso 来源
registry 凭据）。伴生：凭据「行从无到有」当日两次撞上「重启 platform 才生效」（13:44
platform-test 首行重铸、15:1x wire-tester2 首铸），但代码核实**触发路径已存在**（铸币/
粘贴路由 store() 后即调 reapplyProfile），真缺口在交付兜底路径绕过交付控制器、以及身份键
别名嫌疑无观测——修的是确定性与可观测性，不是「补触发」。

## What Changes

- **P0 · 安装闸表驱动补分支**：credential-refs 派发表（REFS）条目可选携带
  connected(email) / missingReason 字段；`credentialConnected` / `credentialMissingReason`
  先查表、命中即返回，未声明字段的 ref 走既有 if 链——wire-customer/lex（顺带同病潜伏的
  wanxing-caller）三 ref 归位，registry/facet-market/chatwoot/paper-trading 四既有 ref
  行为零变化。不是最小两分支补丁：REFS 表头注释自述使命就是「第三个 ref 在这里注册而不是
  分叉编排」，这两个函数正是那个没合拢的分叉；最小补丁会留下下一个新 ref 的同款坑。
- **P1 · 交付兜底归控制器**：`dshUpdateMcp` 的非热交换兜底 restart（零服务器首装/patch
  从无到有时 prevAuth=null → credentialChanged=false → 裸调 `dshBridge.restart`）改走
  交付控制器——撞「restart already in progress」有碰撞重试、忙时推迟到回合边界，不再被
  reapplyProfile 的 catch 吞掉后无人重试（这正是控制器要消灭的事故形态，兜底路径漏网）。
- **P1 · 首行审计事件**：凭据行「从无到有」落库记一条 `credential line created`
  日志事件（email/line/ts）——要的是可观测性。**不在 store() 里加触发**：铸币/粘贴/断开
  三路由已在 store() 后调 reapplyProfile，且 Authorization 快照 diff 的并集比较已把「ref
  服务从无到有」判为凭据变化；再加触发是对同一路径的空操作。
- **身份键别名一步验证**：首行事故的另一嫌疑是写入器用的 runtimeOwnerEmail 与凭据行
  ownerKey 归一化后不一致（ssoUser 优先 vs user、wire-tester2/wiretester2 双 slug 先例）。
  实施时在生产 cell 上比对 `user_line_credentials` 的 email 与 omit 日志的 owner——坐实则
  追加身份归一化修复，不坐实则兜底修复已覆盖机理。
- **验收交叉项（P2 波及面）**：清 Logto 会话的新浏览器完整走一次 wire-customer 铸币——
  铸币的 interactive 重试依赖 Logto consent 自动授权，与 wire-console consent 坏页同机制；
  资产修复本身归 wire/Logto 侧，本 change 只把这个交叉面钉进验收。

### 不做

- 不修 Logto/wire-console 的 consent 资产 404（P2 归 wire/Logto 侧，方案 a/b 由其定夺）；
- 不在 store() 内加交付触发（既有 reapplyProfile 已覆盖，理由见上）；
- 不动 add-line-credential-renewal 的续期/stale 语义与交付控制器本体（dsh-mcp-delivery
  已有重试/推迟/硬顶，本 change 只把兜底路径接进去）；
- 不撤 wire-tester2 的占位 registry 凭据（wire 侧动作，修复上产后执行，见 design 部署注记）。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `line-credentials`: ADD「安装闸按声明的线凭据 ref 判活」——wire-customer/lex（及派发表
  登记的其余线系 ref）条目的 pack 安装与市场卡安装 SHALL 以该线凭据自身连接状态为闸，
  缺凭据的 409 文案与 connectPath 指向该线连接卡；SHALL NOT fall-through 到 registry
  凭据判活。四既有 ref 的闸行为零变化。
- `mcp-integration`: ADD「兜底 restart 路径同受凭据交付确定性管辖」——零服务器首装/patch
  从无到有等落入非热交换兜底的 restart SHALL 经交付控制器（碰撞重试、忙则回合边界、
  硬顶），SHALL NOT 裸调后吞碰撞异常；凭据行从无到有落库 SHALL 记审计事件。

## Impact

- `credential-refs.js`：REFS 条目可选 connected/missingReason 字段 + 两个判活函数改
  表优先（核心改动，两个安装路径 pack-store / routes/extensions 自动受益，无需改动）；
- `server.js`：`dshUpdateMcp` 兜底 restart 改走 credentialDelivery；
- `line-credentials.js`（或其路由层）：首行落库审计事件；
- 验收：e2e 复现序列（无 registry 凭据账号装 wire pack、断开重装 409、lex 同形、四既有
  ref 回归、新 cell 铸首行不重启 5min 内 tool_search 可见）；
- 与在途 `add-line-credential-renewal` 的 delta 无标题冲突：它 MODIFY 的是「MCP server
  tools are registered…」与「Short-lived ID tokens…」两个既有标题，本 change 全部走
  ADDED，归档先后均不冲突、语义互补（它管值变化，本 change 管兜底路径与首行）。
