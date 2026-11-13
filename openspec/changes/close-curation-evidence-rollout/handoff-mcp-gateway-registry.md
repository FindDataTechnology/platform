# 交接：`mcp-gateway-registry` 侧要写什么形状的证据

> 这份文件是**材料**，不是立项。变更要在对方仓的会话里提（本仓只作服务方登记，
> 按 3.1 的原文：不代对方立项）。把这份 + `docs/curation-evidence-fixtures.json`
> 一起带过去，对方的实现就能用本仓的校验器自测。

## 一句话

本仓（paas）已经从**消费侧**冻结了"什么算审过"：`lib/curation-evidence.js` 里
`validateEvidence()` 是唯一判据，`evidenceState()` 把它折成三态。采集端不需要
知道本仓的内部，只需要**产出能过这七个用例的 JSON**。

## 契约锚点

| 用途 | 文件 | 为什么是它 |
|---|---|---|
| 可执行契约 | `lib/curation-evidence.js` | 字段、枚举、错误码都在这里；改语义必然改它 |
| 验收样例 | `docs/curation-evidence-fixtures.json` | 3 条合格 + 7 条不合格，**由单测逐条回放**，不会写歪就过期 |
| 回放用例 | `scripts/test-curation-evidence.mjs` 的「the published fixture file matches the validator」 | 对方可以照这条把 fixture 抄进自己的测试 |
| 人读手册 | `docs/ecosystem-curation.md` §7.3 | 字段含义、三态、与供给态正交的说明 |

## 必须写的字段

```json
{
  "axes": {
    "security": { "verdict": "pass", "reason": "一句话理由" },
    "licence":  { "verdict": "pass", "reason": "LICENSE 原文为 MIT-0" },
    "quality":  { "verdict": "pass", "reason": "带用例与 CI" }
  },
  "pin": { "repo": "github.com/acme/x", "commit": "9f2c1d4e…" },
  "licence": "MIT-0",
  "egress": "allowlist(api.acme.example, cdn.acme.example)",
  "reviewedBy": "ops@acme.example",
  "reviewedAt": "2026-11-01",
  "reviewValidUntil": "2027-11-01"
}
```

- **species 决定轴集合**：`pack` / `facade` / `data-anchor` 用上面三条；
  `plugin` 另加 `P1`（供给面能力）与 `P2`（运行期下载）。**多写的轴是错的**
  ——它会让读者以为存在一个并不存在的审校步骤（`evidence_axis_unexpected`）。
- `verdict` 只能是 `pass` / `reject` / `needs-human`；**`needs-human` 等于没审完**
  （`evidence_axis_incomplete`），不是"接近通过"。
- `pin` 必须有 `commit` 或 `tag`；**浮动分支不是钉点**（`evidence_pin_ref`）。
- `egress` 只能是 `none` / `open` / `allowlist(host, …)`；`allowlist()` 空列表是
  拼错，不是"什么都不放行"（`evidence_egress`）。
- `reviewedBy` 必填：无签名的审不算审（`evidence_reviewed_by`）。
- `reviewedAt` 用 ISO 日（`YYYY-MM-DD`）；`reviewValidUntil` 留空＝永不失效，
  有日期则过期转 `stale`（**不是** `missing`——过期是"该复审了"，缺字段是"没审过"）。

## 七个不合格样例（对方的负例测试就用这些）

| 样例 | 期望状态 | 错误码 |
|---|---|---|
| 某一轴停在 `needs-human` | missing | `evidence_axis_incomplete` |
| `pin` 只写了 `branch: "main"` | missing | `evidence_pin_ref` |
| `egress: "allowlist()"` | missing | `evidence_egress` |
| facade 上多写 `P1` 轴 | missing | `evidence_axis_unexpected` |
| 缺 `reviewedBy` | missing | `evidence_reviewed_by` |
| `reviewValidUntil` 已过（today 之后） | **stale** | —（无错误码，属合法证据但过期） |
| 整块 `evidence` 不存在 | missing | `evidence_missing` |

## 边界（不要越界做的事）

- **别在本仓加"只有流水线能填"的字段**：人工填写的同形证据同样合法，这是
  `curation-evidence` 主规格的一条要求，也是这条线能先落地的原因。
- **别把 `reviewedBy` 往外带**：对外投影（`evidenceSummary()`、广场导出）只出
  `state` / `licence` / `reviewValidUntil`，审校人与逐轴理由留在内部。
- **别在采集端决定"能不能供给"**：那是本仓三道门（predist / 镜像 / CI）的职责；
  采集端只负责把证据写对，与供给态正交。

## 对方立项时可以直接抄的一句

> 采集端 SHALL 产出 `curation-evidence@1` 形状的证据块，并 SHALL 通过
> `docs/curation-evidence-fixtures.json` 的全部样例（本仓单测逐条回放同一文件）；
> 形状以 `paas/lib/curation-evidence.js` 为准，不以文档为准。
