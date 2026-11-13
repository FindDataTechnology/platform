# 垂直样板包（Vertical Packs）演示手册

两个面向客户演示的行业包：**法律-合同、法律-案件**。每个包 = 1 个入口技能 + 1~2 个 MCP server + 1 个对话 agent + 1 个可见角色。客户装 2~3 个条目即得到完整行业助手；入口技能按需点名调用其他 registry 技能（未装则优雅降级，不阻塞）。

数据域样例包已从样例面退役，域内容由柏讯套件线承接（见 §9 数据域退役指针）；样例面不再新增数据域样例包。

技能源码在本仓库 `docs/vertical-packs/skills/`（authoring source of truth），注册进 registry 后由客户通过 Store 安装。

---

## 1. 包构成总表

| | 法律-合同 | 法律-案件 |
|---|---|---|
| 入口技能 | `legal-contract-workflow` | `legal-case-workflow` |
| MCP | `law-bench` | `fd-legal-search-mcp`（落地前由技能驱动——现经 `fd-find-data-business-mcp` 的 `law_search`/`law_read`，见 §3.6）+ `law-bench` |
| Agent | 合同审查官 | 案件分析师 |
| 角色 | `legal` | `legal` |
| 引用的既有技能 | `contract-review`、`contract-copilot` | `preliminary-legal-analysis`、`statute-case-retrieval`、`case-discussion-outline`、`litigation-visualization` |
| 硬约束 | 不编造法条号/条款库结果 | 不编造案号/裁判结果 |

`airegistry-tools`（registry 管理工具）与 `fd-daas-mcp`（工作流/看板组，161 工具）不进演示包。

## 2. 演示动线（每包约 5 分钟）

1. 用带对应角色的账号登录 fd-prod → 左侧 Store。
2. **连接 MCP 市场**（见 §4 凭据）。V1 已上线：点"连接 MCP 市场"→ registry 页面点 `Continue with Logto`（共享 Logto 会话，**全程不输入任何凭据**）。
3. 安装包的 MCP（勾选后无需再填 token）→ 安装入口技能（技能热加载，即装即用）。
4. 进入 Chat，选择包的 agent（合同审查官/案件分析师）。
5. 粘贴 §5 的演示输入 → 全流程跑完。
6. 收尾亮点：打开 Trace 页，指出法条/数据来自真实 MCP 调用（`mcp__<server>__<tool>`），不是模型幻觉。

## 3. 一次性开通（新 operator 按 §3.1→§3.5 顺序执行）

### 3.1 Logto 组（平台侧）与 registry 侧组（两条组源，各管一段）

平台的组（市场可见性 + requiredGroups）和 registry 的组（网关 MCP 调用授权）是**两个 claim 源**：

- **平台侧**（✅ 已配置，2026-09-19）：`logto-auth.js` 把 Logto ID token 的 `organizations`（组织 ID 列表）+ `organization_roles` 映射为平台 groups。由于平台只请求 `urn:logto:scope:organizations`（没有 organization_roles scope），**生效的是组织 ID**。已建两个组织（Logto 管理台 → Organizations）：
  - `legal` → 组织 ID **`hpe07qejcwk7`**（法律-合同/案件包）
  - `analysts` → 组织 ID **`sl63fy08ruh9`**（数据域；样例包已退役，见 §9——组保留给数据域条目与柏讯套件线的既有使用者）
  - 演示成员：平台管理员账号（下同）已加入两个组织（验证：登录后市场正确显示 law-bench/fd-*/两包入口技能，152 技能可见）。
  - `registry-groups.json` 与云端 agents.json 的组列表都**同时含可读名和组织 ID**（交集语义，命中其一即可）——将来平台补请求 `urn:logto:scope:organization_roles` 并用角色名时无需改映射。
  - 新增演示用户：Logto 管理台把用户加入对应组织即可（无需改任何配置）。
- **registry 侧**（已配置好，2026-09-19）：auth-server 已启用 `IDP_USER_GROUP_FALLBACK_ENABLED_PROVIDERS=pingfederate,logto`——Logto 全局 roles 为空的用户会从 `idp_user_groups` 集合取组。管理员可通过 API 给用户加组（无需 Logto 权限）：

  ```bash
  curl -X POST http://127.0.0.1:18080/api/iam/user-groups \
    -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
    -d '{"username":"<registry用户名>","groups":["legal"],"description":"vertical-pack demo"}'
  ```
  已建示例记录：`aloadtree → [legal, analysts]`。注意：用户若在 Logto 有全局角色（groups claim 非空），fallback 不生效——演示账号保持无全局角色即可。

### 3.2 Registry scope 授权（registry 侧）

目的：当前 registry 只有 admin scope 有 server 访问权（这是所有非 admin 调用 401 的根源）。为 `legal`/`analysts` 组建 scope 并授予 server 访问：

- `mcp-law-bench/execute` → server `law-bench`（methods/tools: all）→ groups `["legal"]`
- `mcp-data-servers/execute` → servers `fd-open-data-mcp`, `fd-cn-report`, `fd-daas-mcp` → groups `["analysts","legal"]`

操作路径：registry 管理 UI（IAM）配置；若 IAM 列表接口异常（已知问题），cheap1 上直写 Mongo（先备份）：

```bash
ssh cheap1
# 备份
docker exec mcp-mongodb sh -c 'mongodump -u admin -p "<PASS>" --authenticationDatabase admin --db mcp_registry --collection mcp_scopes_default' 
# 写入（PASS 取 /opt/mcp-gateway-registry/.env 的 DOCUMENTDB_PASSWORD）
docker exec mcp-mongodb mongosh -u admin -p "<PASS>" --authenticationDatabase admin --eval '...insert scope docs...'
```

验证：`legal` 组用户 mint 的 JWT 调 `POST https://mcp.finddatatech.cloud/fd-open-data-mcp/mcp` initialize 返回 200；无组用户 401。

### 3.3 law-bench 后端凭据（✅ 已解决，2026-09-19 spike）

spike 结论：网关 scope 校验从来不是问题；401 的根因是 **law-bench 后端有自己的 token 鉴权**（`MCP_HTTP_TOKEN`），而 registry 的 MCP 代理只从 **egress vault** 注入上游凭据，该特性默认关闭。已执行：

1. registry `.env`：`EGRESS_AUTH_ENABLED=true`（备份 `.env.bak-egress-20260919`），`docker compose up -d --no-deps registry auth-server` 重建。
2. law-bench 已配为 egress `pat` 模式（注入头从 server 的 auth_scheme=api_key 派生为 `X-API-Key`）。
3. 端到端验证：admin 账号经 `https://mcp.finddatatech.cloud/law-bench/mcp` initialize → **HTTP 200**（v3.4.7，52 工具）。

**每个演示用户仍需一次性存 PAT**（per-user vault，30 天上限）：演示账号登录 registry 后在 Connected Accounts 页提交（或 admin 代存）：

```bash
# admin 代存（绕过 safeline 直连 registry，见下方 WAF 注意项）
curl -X PUT http://127.0.0.1:18080/api/servers/law-bench/egress-pat \
  -H "Authorization: Bearer <该用户registry JWT>" -H "Content-Type: application/json" \
  -d '{"secret":"<law-bench MCP_HTTP_TOKEN>","ttl_value":30,"ttl_unit":"days"}'
# admin 代他人存: 加 "sub":"<目标sub>","auth_method":"<目标登录方式>"
```

PAT 来源：`kubectl --context cheap -n law-bench get secret law-bench-mcp -o jsonpath='{.data.MCP_HTTP_TOKEN}' | base64 -d`。

**fd-\* server 不需要此步**——它们只校验调用方 registry JWT（2026-09-19 实测 initialize 200）。

**⚠️ WAF 注意**：safeline 的路由表尚不认识 `/api/servers/*/egress-auth`、`/egress-pat` 等新路由（公开入口 404）。要么在 safeline 控制台加白名单让用户走 Connected Accounts 页自助，要么演示前由 admin 直连 cheap1 的 127.0.0.1:18080 代存（上面命令已绕过）。

### 3.4 `registry-groups.json`（fd-prod，市场可见性门控）

fd-prod 平台容器 CWD 下的 `registry-groups.json`：

```json
{
  "servers": {
    "law-bench": ["legal"],
    "fd-open-data-mcp": ["analysts"],
    "fd-cn-report": ["analysts"],
    "fd-daas-mcp": ["analysts"]
  },
  "skills": {
    "legal-contract-workflow": ["legal"],
    "legal-case-workflow": ["legal"],
    "stock-research-workflow": ["analysts"],
    "china-macro-brief-workflow": ["analysts"]
  },
  "agents": {}
}
```

（引用的既有技能暂不门控——减少演示时"看不到条目"的排障面。）其中数据域条目（`fd-open-data-mcp`/`fd-cn-report`/`fd-daas-mcp` 与 `stock-research-workflow`/`china-macro-brief-workflow`）不再属于样例面：保留是为了既有订阅者不被破坏（退役不删版本、不断订阅，见 §9），fresh 演示复现只需上表两个法律条目。应用后 rollout，验证：两种角色登录 Store 各自只见本角色包条目。

### 3.5 技能与 agent 注册（✅ 已完成，2026-09-19）

**托管**：SKILL.md + agents.json 已发布到公开仓库 **`github.com/FindDataTechnology/fd-vertical-packs`**（本仓库 `docs/vertical-packs/` 仍为创作源，**改内容后需同步推送该仓库**）。当前样例面两包两份；已退役数据域的两份仅作存档（见 §9）。选 GitHub 的依据：registry 现有 143 技能中 121 个托管于 raw.githubusercontent.com（可达性已被持续扫描证明），实测 registry 主机 0.9s 可达。

- **技能**：两包入口技能已注册（`POST /api/skills` 全部 201，enabled/active，内容端点 `/api/skills/<name>/content` 返回完整正文）。注册命令模式：

  ```bash
  curl -X POST http://127.0.0.1:18080/api/skills \
    -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
    -d '{"name":"...","description":"...","skill_md_url":"https://raw.githubusercontent.com/FindDataTechnology/fd-vertical-packs/main/skills/<name>/SKILL.md","tags":["法律","合同审查"],"status":"active"}'
  ```

  **⚠️ 内容漂移会自动停用技能（2026-09-24 彩排实测）**：registry 为每个注册技能记内容基线；注册后若 GitHub 上的 SKILL.md 被修改（如 4.2 的 conditional→live 改写），drift 检出后该技能被自动 `is_enabled=false`——市场与 `GET /api/skills` 列表随即消失，`/content` 返回 409（"Re-register to update the baseline"）。**PUT 更新不会重置基线**；修复 = 同参数 `DELETE` + `POST` 重新注册（重新抓基线、恢复 enabled）。改内容后务必重新注册并复查 `is_enabled`。

- **Agent**：云端目录文档即仓库内 `agents.json`（三条 chat entry，凭证仅 `apiKeyEnv: FD_TOKEN_API_KEY`）；fd-prod 已配 `AGENTS_CONFIG_URL`（fd-infra-deploy 147ffc6）+ `FD_TOKEN_API_KEY` secret，rollout 完成，catalog 合并验证通过。

**⚠️ 模型选择（实测结论）**：agent 用 `deepseek-v4-flash-0731`。该公开网关对 `deepseek-v4-pro`/`deepseek-v4-flash` 要求 `x-opencode-session` 头（平台的 agent 调用不带此头会 400），而 `0731` 免头直通——正好也是平台自己的默认模型。**不要把 agent 模型改回 pro，除非平台侧增加该请求头。**

### 3.6 fd-find-data-business-mcp（法条检索，✅ 2026-09-19 已接入）

FindData 商业数据 MCP（zihan 机 `100.64.0.4:30803`，Tailscale 可达），9 工具：`law_search`/`law_read`（中国法律法规）、`yearbook_search_indicators`/`yearbook_read`（统计年鉴）、`read`/`read_range`/`list_concepts`/`ai_search`/`graph_search`（FindData 指标）。接入要点（复现时参考）：

- **鉴权**：该服务器只接受 Logto JWT（`FDBIZ_ISSUER=auth.finddatatech.cloud`，aud=`https://api.finddatatech.cloud/mcp`，ES384）。gateway 的 obo_exchange 不支持 Logto，走 **egress pat**：用 registry 的 M2M client（`LOGTO_M2M_CLIENT_ID/SECRET`）client_credentials 换该 audience 的 JWT，存为 per-user PAT（注册时 `auth_scheme=bearer` → 注入头 `Authorization: Bearer`，与后端校验完全匹配）。
- **PAT 续期**：Logto token 约 1h 有效。cheap1 上 `/opt/mcp-gateway-registry/refresh-fdbiz-pat.sh`（cron 每小时 :14/:44）自动换新并 PUT 到 egress-pat；依赖 `.admin-jwt` 文件（168h 有效，**每周需在 registry UI 重签并更新该文件**，与 MARKET_REGISTRY_TOKEN 同节奏）。
- **SSRF 允许清单**：`SSRF_ALLOWED_CIDRS=100.64.0.8/32,100.64.0.4/32`（zihan 已加，.env 已备份）。
- **端到端验证**：公网网关 `law_search(title_query=劳动合同)` 返回真实法规（劳动合同法/实施条例/上海条例 + 效力状态）。
- **边界**：类案（裁判文书）检索无数据源；该服务器的法规库不含司法案例。

## 4. MCP 凭据（V1 已上线，V0 为回退）

**V1（现状，2026-09-21 起，fd-prod `sha-cc148eb` 起可用）**：
- Store 页 → **连接 MCP 市场**。无 registry 会话时弹出一个 registry 窗口，点其中的 `Continue with Logto` 即完成（复用平台登录建立的 Logto 会话，**不输入任何凭据**）；已有 registry 会话时点一次即连上。凭据按用户存储（`user_registry_credentials`），TTL 168h。
- 安装 registry 来源的 MCP 时表单**不再出现 token 栏**：记录只存 `credentialRef: "registry"`，真实 token 在写入 dsh profile 时按用户解析注入（`mcp.patch.yml` 里的 `Authorization: Bearer …`）。
- 凭据过期或被 registry 拒绝：首个 401 会把该凭据标记为 stale 并推 `registry_credential_stale`，Store 显示"重新连接"提示——**重新连接即可，无需重装 MCP**。
- **法律-合同包额外一步**：law-bench 的后端凭据（`MCB_HTTP_TOKEN`）由 registry 侧 egress PAT 注入（§3.3），与用户凭据无关，演示账号无需操作。
- 现场实测（2026-09-21，平台管理员账号）：连接 → 安装 registry MCP → profile 注入 → `initialize`/`tools/list` 成功（7 工具）→ 一轮对话 → 卸载，全程零凭据输入。复现脚本：`scripts/verify-live-connect-flow.mjs`。

**V0（回退路径，registry 会话拿不到时用）**：
- registry UI → 登录 → Get JWT Token（TTL 168h）→ 在 Store 的连接面板选"粘贴 token"。
- 存储、注入、过期处理与 V1 完全一致（只有取得 token 的方式不同）。

law-bench 为 `group-restricted`：客户账号 mint 的 JWT 必须含 `legal` 组（§3.2 配好后自动带上），否则安装后调用仍 401。

## 5. 演示输入（预置料）

**法律-合同**（贴入一段采购合同节选，含 3 处埋点：违约金上限缺失、验收条款单方化、争议解决模糊）：
> 我方是买方（甲方），请审查以下采购合同节选的风险并给出修改建议：
> （此处粘贴含上述三处问题的合同文本 800~1200 字）

预期交付：五阶段报告——结构化提取表 → 风险明细表（3 处埋点全部命中，分级正确）→ 可直接替换的条款措辞 → 法条附录 + 置信度标注 + 律师复核提醒。

**法律-案件**（案情一段：员工主张违法解除赔偿，用人单位以"严重违反规章制度"抗辩但制度未经民主程序）：
> 我代理劳动者。案情：……（入职 3 年，月工资 2 万，被以"严重违反规章制度"解除，规章未经民主程序制定，未支付未休年假工资）
> 请做案件研判：争议焦点、法条依据、诉讼策略。

预期交付：争点清单（要件缺口：制度效力）→ 法条清单（`law_search`/`law_read` 实查劳动合同法及实施条例，标注效力状态）→ 攻防表 → 策略（2N 赔偿主张 + 年假时效风险提示）。类案检索暂无数据源，报告注明"类案检索未启用"。

数据域 canned demo（股票研究、宏观简报）随样例退役移出本手册——该工作流现由柏讯套件线承接，见 §9。

## 6. 云端 agents 目录条目（§3.5 agent 注册用）

```json
{
  "agents": [
    { "id": "pack-contract-reviewer", "type": "agent-remote", "mode": "chat",
      "name": "合同审查官", "description": "法律-合同包对话入口，配合 legal-contract-workflow 技能使用",
      "icon": "scale", "baseUrl": "https://token.finddatatech.cloud/v1", "model": "deepseek-v4-flash-0731",
      "apiKeyEnv": "FD_TOKEN_API_KEY", "tags": ["法律", "合同"], "roles": ["legal"] },
    { "id": "pack-case-analyst", "type": "agent-remote", "mode": "chat",
      "name": "案件分析师", "description": "法律-案件包对话入口，配合 legal-case-workflow 技能使用",
      "icon": "gavel", "baseUrl": "https://token.finddatatech.cloud/v1", "model": "deepseek-v4-flash-0731",
      "apiKeyEnv": "FD_TOKEN_API_KEY", "tags": ["法律", "诉讼"], "roles": ["legal"] }
  ]
}
```

（历史上的第三条 `pack-industry-analyst`（行业分析师）随数据域样例退役——已部署环境上在册的条目**不主动删除**：条目下线即回收 preset（§6.1），既有订阅者不受影响即可；fresh 演示复现只需上面两条，见 §9。）

fd-prod 部署：`FD_TOKEN_API_KEY` 进 `platform-secrets`，`AGENTS_CONFIG_URL` 指 §6 文档 URL 进 `platform-config`，rollout。

### 6.1 这些 agent 怎么运行（2026-09-21 修复后）

平台把每个 `chat` 模式的目录条目编译成一个**本地 agent preset**（persona），而不是转发到它的 `chat/completions` 端点：

- 启动时（以及目录每次变化时）从 dsh 自带的 `standard` 组合复制一份，只替换 persona 行 → `$DSH_HOME/.agent-presets/<entry-id>/{preset.yml,agent.cordis.yml}`；带标记文件，条目下线即回收，不覆盖手写 preset。
- 选中该 agent = 切换 preset（与切换模型/工作区同一条重启路径，UI 有 spinner），**下一轮对话就在本地运行时**：persona + 平台的 163 个 MCP 工具 + 技能 + 会话记忆全都在。会话头部（`标准模式` 那个位置）显示 agent 名。
- persona 文案优先取条目的 `persona` 字段；没写就由 `name` / `description` / `tags` 生成（含"不要编造数据/结论""标注来源"的约束）。要改角色语气，直接在 agents.json 加 `persona` 即可，无需改平台。
- 如果某个条目**本来就是远端 agent 服务**（不是 persona 包装），在条目上写 `"local": false`：平台不为它生成 preset，对话按原来的 OpenAI 兼容转发路径走（该路径现在也会带上会话历史与身份说明）。

为什么改：远端转发是一条"裸 LLM"路径——单条消息、没有 system prompt、没有工具。实测选到包 agent 后助手会回答"我没有任何 MCP 工具"，并编造一份 14 个 server 的清单，包的技能与 MCP 全都用不上；客户演示会直接翻车。详见 change `add-vertical-sample-packs` §6。


## 7. 回滚

注销 registry 条目（两包 2 技能 + 未来 1 server；数据域退役条目的处置走 §9 的管理面，不在本回滚内）/ 删除云端 agent 条目 / 还原 `registry-groups.json`。无平台状态迁移。

## 8. 已知边界（如实告知客户）

- 案件包的**法条检索已实**（`fd-find-data-business-mcp` 的 `law_search`/`law_read`，真实法规库）；**类案（裁判文书）检索仍无数据源**，演示时如实说明。
- chatlaw / fingpt 卡片是生态展示（GitHub link），对话入口用包的 chat agent。
- 凭据 TTL 168h：到期后已安装的 MCP 会 401，平台随即把凭据标为 stale 并在 Store 提示"重新连接"（点一次 `Continue with Logto` 即恢复，无需重装）。law-bench 的 egress PAT 有效期 30 天（至 2026-10-18，admin 账号），与用户凭据互不影响。
- 公开 LLM 网关偶发 502（实测约 1/5 瞬时抖动，重试即恢复；平台 agent 调用无自动重试）——演示时若首答失败，重发一次即可。
- **默认模型与工具选择（2026-09-24 更新）**：默认模型已切换为 finddata-token 的 **`deepseek/deepseek-v4.1-flash`**（maxTokens 32768）。彩排实测法律两包 canned demo 全部达标（数据域样例当时同样达标，现已随退役收束，见 §9），chat 内真实 MCP 调用稳定（law-bench / fd-find-data-business-mcp / fd-cn-report / fd-open-data-mcp 合计 36+ 次）。此前默认的免费 `liquid/lfm-2.5-2.6b:free` 无法在 ~190 工具清单下选对工具（chat 内 mcp__ 调用为 0，还偶发畸形调用把报错带进回复）——**演示前勿切回免费小模型**。模型条目的 `maxTokens` 勿低于 32768：全流程报告 8192 会被截断（turn/end reason=max-tokens）。
- 包 agent 现在跑在**本地运行时**（§6.1）：persona 的模型就是平台当前选中的模型（端点条目的 `model` 字段只在回退转发时生效）；切换 agent 会重启 dsh 子进程（约 5-10 秒），且 persona 对**下一个**会话生效，当前会话继续用原有 persona（UI 头部标签显示的是会话真实 preset）。
- 每个 agent 的 persona preset 由目录条目生成，标记文件在 `$DSH_HOME/.agent-presets/<id>/`；要手写不同语气，优先在 agents.json 里加 `persona` 字段。
- registry 的 egress 相关 API（Connected Accounts 自助存 PAT）被 safeline WAF 拦截（404），目前由 admin 直连 cheap1 代存（§3.3）。

## 9. 数据域退役指针

数据域的两个样例包——**数据-股票** 与 **数据-中国经济**——已从样例面退役（user ruling 2026-10-25，柏讯套件线为数据域 pack 的单一真源）。退役后的去向与不变量：

- **域内容由柏讯套件线承接**（market 上架）：股票研究工作流 → **柏讯·估值套件**；宏观简报工作流 → **柏讯·宏观研究套件**（样例技能若有套件未覆盖的差异，先并版进对应套件再退役）。柏讯套件线另覆盖区域经济（柏讯·区域经济套件）、行业企业（柏讯·行业与企业套件）等数据域。
- **原包 unlisted，不删版本**：已发布版本对既有订阅者保持可拉取（fetchable），订阅不被破坏，re-list 可逆——unlist 是唯一动作，删除版本被禁止。
- **样例面不再新增数据域样例包**：数据域 pack 一律走柏讯套件线。
- **同名防呆**：市场发布闸已拒绝同作者同名重复发布（一作者一名，listed 或 unlisted 均算）；既有的同域重复收敛走管理面 unlist/retire，不开发布侧豁免。
