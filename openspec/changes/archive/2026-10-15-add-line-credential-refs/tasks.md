# Tasks: add-line-credential-refs

## 1. 存储与模块

- [x] 1.1 db v31 `user_line_credentials`（email, line PK；token, token_exp, stale, updated_at）+ 访问器
      （v29/v30 被并行会话占用，顺延至 v31）
- [x] 1.2 `line-credentials.js`：三线分型（liveToken/markInvalid/status/pair-or-paste 投影）
- [x] 1.3 credential-refs.js 注册三 ref（staleEvent=line_credential_stale）

## 2. 路由与铸凭据

- [x] 2.1 server/routes/line-credentials.js（GET connection/POST credential/DELETE/mint start+callback）
      + server.js 挂载
- [x] 2.2 服务端中介的授权码往返（design D2 rev.）：
      - 首版浏览器弹窗轮询方案在生产**不可行**（跨域读弹窗 location 必 SecurityError；
        wire auth/config 无 CORS）——e2e 点「连接」实锤；
      - 修=给 wire/lex 两个 Logto client 注册平台回调（`/api/lines/{line}/mint/callback`），
        mint/start（服务端读 config+PKCE+prompt=none+state 签名 cookie）→ Logto → 回调平台 origin
        → 服务端 code→token 交换（PKCE，无 client secret）→ 302 /settings/mcp?tab=market；
      - state+nonce 自校；login_required/consent_required 自动降级一次交互授权；失败落
        ?lineError= 可读标记（不回声上游 body）
- [x] 2.3 面板三卡（柏讯/识律「连接」整页跳 start；萬星 caller 粘贴）+ core api 类型
- [x] 2.4 mcp.json 基线三行（本地+configmap）

## 3. 测试

- [x] 3.1 模块单测：三线分型（ID token exp 解析/sk- 形状）、翻面语义、投影无密钥
- [x] 3.2 路由单测：形状校验、mint/start（PKCE+prompt=none+签名 cookie）、mint/callback
      （服务端交换+落库+落点、state 伪造、nonce 不匹配、交互降级恰一次、匿名 401/未知线 404）
      ——12/12 绿
- [x] 3.3 web 类型检查零错

## 4. 上线与验收

- [x] 4.1 出片双滚（platform/platform-demo）+ configmap 三行落库 + restart
      （sha-1871fbd 首滚；修复后 sha-34d147f 再滚，platform+facet 双清单，
      digest fda9c42f 已 skopeo 硬门；pod 内新路由 401 门实证）
- [x] 4.2 生产 e2e（真实浏览器 + pod 内真调用）：
      - 柏讯「连接」→ 静默铸成功（无交互，Logto 会话在）→ 卡「已连接 · 至 20:20」
      - 识律「连接」→ 同上（至 21:21）
      - 萬星 Caller 粘贴 sk- → 卡「已连接」
      - cell 8e28bad8 profile 三行 Authorization 全注入（wire aud=i0oxd…、lex aud=91kqy7…、
        caller sk-…）；wire-ops 10 工具/lex-ops 8 工具/wanxing-ops 8 工具全可见
      - 真调用：wire_market_browse 200（新开户空列表正常，401「尚未映射客户」经浏览器首登
        开户后转 200）；lex_surface_overview 200 真数据（32,275 部法规目录）；lex_me 403
        =上游组织门诚实判定（vaas-trial 不在 lex-customers）；wanxing_agents_browse 200 真目录；
        **wanxing_agent_turn 真回合成功**（pack-demo-fingpt 回复「好」，key72 last_used 19:40:06 计费实锤）
- [x] 4.3 台账/roadmap/记忆收口
