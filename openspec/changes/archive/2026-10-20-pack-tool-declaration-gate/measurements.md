# pack-tool-declaration-gate · 生产验证记录（2026-10-20）

> 环境：fd-prod（kube context `cheap`），镜像 `ccr.ccs.tencentyun.com/yizuo/platform:sha-b7752cf`
> （digest `1d563371`，≙ paas `620dbadc`，含本 change）。
> 开关：`platform-config` 的 `PACK_TOOL_FACE_GATE=enforce`；platform 与 facet 进程内
> `printenv` 均为 `enforce`（facet 是发布路径所在，必须换到含本 change 的镜像——已满足）。
> 回滚：改回 `warn`（只记录不拒绝）或 `off`，逐请求读取，无需重启。

## 1. 模块级活体

```bash
kubectl --context cheap -n fd-prod exec deploy/facet -- sh -c \
  'grep -c fullSurface lib/pack-manifest.js; grep -c "publish-tool-face-gate" gateway/packs.js'
# → 11 / 1
kubectl --context cheap -n fd-prod exec deploy/platform -- sh -c \
  'ls lib/full-mode-tool-scope.js; grep -c deriveFullModeToolScope dsh-profile.js'
# → 存在 / 2
```

## 2. 端到端判词（走 `/api/packs/validate`，与发布同一收集器，不落任何数据）

用 facet 的 `x-facet-token` + `x-facet-user`（base64url）从 platform pod 直打 `127.0.0.1:3200`：

**负向**（`mcpServers: [{registryName: "airegistry-tools"}]`，无声明）：

```json
{
  "valid": false,
  "errors": [{
    "error": "Invalid manifest",
    "errors": [{
      "error": "pack 'gate-probe-undeclared' MCP reference 'airegistry-tools' declares no tool face: declare its tool names in allowTools, or mark the reference fullSurface with a non-empty reason",
      "entry": "mcpServers:airegistry-tools"
    }],
    "toolFace": true
  }]
}
```

**正向**（同一引用加 `fullSurface: true` + `fullSurfaceReason`）：

```json
{ "valid": true, "errors": [] }
```

发布路径 `POST /api/packs` 对同一判词返回 400（`collectPublishVerdict` 的 shortCircuit 取第一项），
validate 以 200 报告全部问题——这是既有设计，两者共用同一收集器。

## 2.1 其余三条判词（同一端点，2026-10-20 补测）

| 用例 | 结果 |
|---|---|
| `allowTools` 与 `fullSurface` 并存 | `Invalid manifest` + `mcpServers[0]`：`allowTools and fullSurface are mutually exclusive; declare the tools or mark the reference full-surface, not both`（形状层拒绝） |
| 技能正文点名 `search_registry`，但 `allowTools=[list_services]` | `Invalid manifest` + `toolFace: true`：`pack 'gate-probe-closure' skill(s) [gate-probe-skill] name 'search_registry' on MCP server 'airegistry-tools', outside that reference's allowTools (add it to the declaration, or mark the reference fullSurface)` |
| 同一技能正文 + `fullSurface` | `errors: []`（闭包豁免） |

这三条与 §2 的两条合起来覆盖了 A6 的发布侧验收矩阵（安装兼容性由单测与 e2e 覆盖，
不在生产上装测试包）。

## 3. 在架 pack 的声明面（enforce 的暴露面）

`/data/facet/packs.db` 每个 pack 的最新版本：

- 带 MCP 引用的最新版：**50** 个；**完全声明 38**；**仍无声明 12**。

仍无声明的 12 个（下一次发版会被 400 挡下，直到补声明或标 `fullSurface`）：

| pack | 版本 | 未声明引用 |
|---|---|---|
| 数据-股票 | v3 | fd-open-data-mcp, fd-cn-report |
| 数据-中国经济 | v3 | fd-open-data-mcp, fd-cn-report |
| 柏讯 · 投委会 | v1（旧 id） | fd-quant, fd-cn-report, fd-find-data-business-mcp |
| 柏讯 · 自适应轮动套件 | v1（旧 id） | fd-quant, fd-paper-trading, fd-daas-mcp, fd-cn-report |
| 法律-合同 | v1 | law-bench |
| 法律-案件 | v4 | fd-find-data-business-mcp, law-bench, fd-legal-search-mcp |
| 萬星 · 本地内容发布套件 | v4 | vaas-wanxing |
| 物化验证（切片④ 谦面物化器） | v1 ×2 个 id | fd-open-data-mcp |
| 物化验证·ACP（切片④） | v1 ×3 个 id | fd-open-data-mcp |

其中「物化验证…」「萬星…」「法律-合同/案件」「数据-中国经济」不在作者仓 34 个回填包内；
`数据-股票` v3 与两个旧 id 的柏讯包是回填批次未覆盖到的存量。**安装路径不受影响**：
这些已发布版本照常可装，旧 cell 按全量运行（安全阀）。

## 4. 已装引用的版本分布

9 个 cell 共 **41** 条已装引用：**30 条落后于最新发布版本**；最新版本里带完整声明的 36 条。
这与 B 的测量互相印证——回填已发布，但用户装的是旧快照。

## 5. `warn` 观察窗说明

本 change 的 5.1（`warn` 观察一周）**没有形成观察数据**：核实生产时开关已经是 `enforce`
（`platform-config` 由 `kubectl-patch` 于 2026-10-20T09:35:43Z 更新，pod 09:36Z 重启），
facet 日志里没有 `[publish-tool-face-gate] warn-only` 行。替代依据是回填前的 registry 预检：
34 份 manifest / 11 个 server / `faceViolations=0` / `unresolved=0`（见 handoff §3），
以及作者仓批次已在 2026-10-20T02:00Z 前后收尾（`pack_versions.published_at`）。

## 6. 结论

- 工具面门在 facet 进程内按 `enforce` 生效，判词与单测/预检一致（两种修法都点名）。
- 存量不受影响：安装路径不做该门；旧版本照常装、按全量运行。
- 剩余动作在作者侧：§3 的 12 个包在下一次发版前补声明或标 `fullSurface`。
