# full-mode-tool-scope · 生产测量记录（2026-10-20）

> 环境：fd-prod（kube context `cheap`），镜像 `ccr.ccs.tencentyun.com/yizuo/platform:sha-b7752cf`
> （digest `1d563371`，≙ paas `620dbadc`，含本 change）。
> 开关：`platform-config` 的 `FULL_MODE_TOOL_SCOPE=on`；platform / facet / platform-demo 三个 pod
> 于 2026-10-20T09:36Z 前后重启，进程内 `printenv` 已读到 `on`。
> 回滚：把该键改回 `off`（或删键）后重启，合成结果回到 `{"mcpTools":{}}`。

## 1. 物化实证（运行时真正读的那份文件）

`/data/cells/<cell>/dsh/profiles/platform/tool-filter.json`：

| cell | 已装 pack | 物化内容 | 说明 |
|---|---:|---|---|
| `1da519d4c1c0bf89` | 7 | `{"airegistry-tools":5,"facet-market-mcp":5}` | 09:36:29 写出，并集生效 |
| `3fdc7b8e8ac03b68` | 26 | `{"mcpTools":{}}` | 上次合成早于开关翻转（10-18 13:07），下次合成生效 |
| 其余 7 个有 pack 的 cell | 1–2 | `{"mcpTools":{}}` | 所装版本全为回填前版本 → 安全阀按全量处理 |

**安全阀按设计工作**：cell `1da519d4c1c0bf89` 里 `数据-股票` / `柏讯 · 投委会` 等仍是未声明版本，
对应 server（`fd-open-data-mcp`、`fd-cn-report`、`fd-quant`、`fd-daas-mcp`…）全部保持全量，
只有 `airegistry-tools` 与 `facet-market-mcp` 被收窄——没有出现 `{server: []}`。

**运行时链路证据**（不只文件存在）：

- profile 里物化了 `platform-tool-scope.js`（23,435 B，含 `tool-filter.json` 读取与
  「Settings → MCP」拒绝文案）与 `tool-filter.json`（377 B），时间戳同为 09:36。
- 该 cell 的 dsh agent 进程（`/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile platform
  --patch /data/cells/1da519d4c1c0bf89/dsh/profiles/platform/*.patch.yml`）启动于 **09:36:32.1**，
  晚于 filter 写入的 **09:36:29.0**——即当前活着的 agent 是在并集落盘之后加载的。

## 2. 并集 vs 全量（已装版本 → 升级后）

全量工具数取自 registry 实时 `tool_list`（`GET /api/servers?limit=500`，24 个 server）；
并集用 `lib/full-mode-tool-scope.js` 的 `deriveFullModeToolScope()` 对每个 cell 的
`installed_packs` 快照重算。「升级后」= 把该 cell 每个 pack 替换为其最新已发布版本的 manifest。

| cell | pack 数 | 当前收窄（声明/全量） | 当前节省 | 升级后收窄 | 升级后节省 |
|---|---:|---|---:|---|---:|
| `1da519d4c1c0bf89` | 7 | airegistry-tools 5/7、facet-market-mcp 5/7 | 4 | fd-daas-mcp 40/161、fd-quant 8/50、fd-sentiment 5/8、fd-paper-trading 1/19、airegistry-tools 5/7、facet-market-mcp 5/7 | **188** |
| `3fdc7b8e8ac03b68` | 26 | eco-mcp-time 2/2、eco-mcp-fetch 1/1、facet-market-mcp 6/7、facet-ops-mcp 6/6 | 1 | fd-daas-mcp 28/161、fd-open-data-mcp 16/71、fd-cn-report 27/44、fd-quant 42/50、fd-find-data-business-mcp 24/32、fd-legal-search-mcp 8/10、fd-paper-trading 18/19、fd-text-core 5/15、facet-market-mcp 6/7、facet-ops-mcp 6/6、eco-mcp-time 2/2、eco-mcp-fetch 1/1 | **235** |
| `0f483a072f22ae37` / `582c630c244bf00a` / `6db2b1b4b490223b` | 1–2 | null | 0 | 识律类：fd-legal-search-mcp 4/10、fd-find-data-business-mcp 2/32 | 36 |
| `420a3344ecc07204` / `7d1a5c2107d79ea3` / `d15c260e97513dab` | 1 | null | 0 | fd-paper-trading 16/19 | 3 |
| `ff9b82e46fd31be0` | 1 | null | 0 | fd-text-core 2/15 | 13 |

**为什么现在只有个位数收益**：41 条已装引用里 **30 条落后于最新发布版本**。用户装的是订阅时的
版本快照，作者仓回填并重发不会追溯改变已装版本；只有用户升级（或重装）后，并集才会用上声明。
上表「升级后」列就是升级完成时的真实并集。

## 3. token 估算（每轮上下文）

用需求书 §1 的实测 schema token（cl100k，真实 `FastMCP.list_tools()`）按工具数比例折算：

| server | 全量工具 | 全量 token | cell 3fdc 声明后 | 省下 token |
|---|---:|---:|---:|---:|
| fd-quant | 50 | 48,818 | 42 | ~7,811 |
| fd-daas-mcp | 161 | ~33,400 | 28 | ~27,598 |
| fd-open-data-mcp | 71 | 19,795 | 16 | ~15,335 |
| fd-find-data-business-mcp | 32 | ~16,700 | 24 | ~4,175 |
| fd-cn-report | 44 | 10,114 | 27 | ~3,908 |
| fd-paper-trading | 19 | ~6,400 | 18 | ~337 |
| fd-legal-search-mcp | 10 | ~3,600 | 8 | ~720 |
| fd-text-core | 15 | 未测 | 5 | 未测（≥10 个工具） |
| **合计（已测部分）** | | | | **≈ 59,900 token/轮** |

cell `1da519d4c1c0bf89` 升级后已测部分约 **72,200 token/轮**（fd-quant ~41,000 + fd-daas ~25,100
+ fd-paper-trading ~6,100）。

口径说明：这是**按工具数比例**的估算，不是逐轮 prompt 实测；真实每轮还受 prompt cache 命中率与
工具注册顺序影响。估算与需求书 §10「三 pack cell 降幅 ≥60k」同量级。

## 4. 为什么没有 `--turn-trace` 数字

`scripts/probe-pack-scope.mjs` 在本环境拿不到可用基线：它用一次性 `DSH_HOME` 合成，凭据按
「机器主人」解析，cell 里的 `MARKET_REGISTRY_TOKEN` 类引用被 fail-open 省略——实测 full roster
只剩 `websearch` 1 个 server（2 tools），不能作为分母。`--turn-trace` 需要真实用户会话与 WS 鉴权，
在别人的 cell 上跑等于替用户发消息，未做。

替代证据就是 §1 的**运行时物化文件**（bridge 真正读取的那份）加 §2 的并集重算——比探针更贴近事实。

## 5. 复现命令

```bash
# 物化内容
kubectl --context cheap -n fd-prod exec deploy/platform -- \
  sh -c 'cat /data/cells/1da519d4c1c0bf89/dsh/profiles/platform/tool-filter.json'

# 并集重算 + 全量对照（脚本见本次记录；核心是 deriveFullModeToolScope + registry tool_list）
kubectl --context cheap -n fd-prod exec -i deploy/platform -- node - <<'EOF'
const { default: Database } = await import("better-sqlite3");
const { deriveFullModeToolScope } = await import("/app/lib/full-mode-tool-scope.js");
// ... 读每个 cell 的 installed_packs → derive → 与 registry tool_list 对比
EOF
```

## 6. 结论

- 开关 `on` 已生效，并集与安全阀行为与单测/集成测试一致；无 `{server: []}`，无 server 消失。
- **收益兑现的前置条件是「用户升级已装 pack」**，不是「作者重发」。当前生产 41 条已装引用中
  30 条落后；升级后 cell `3fdc7b8e8ac03b68` 每轮可省约 60k token，cell `1da519d4c1c0bf89` 约 72k。
- 观察项：用户报「工具不见了」时，先查该 cell 的 `tool-filter.json` 与已装版本；用
  设置 → MCP 的「完整工具面」开关可对单个 server 立即恢复全量（覆盖 = 删键）。
