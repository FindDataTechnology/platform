# 部署键落库 + 真回合 + 计费实证（2026-11-07 凌晨）

## 1. 部署键（任务 3.1/3.2）

`deployment_keys` 表真主键 = `PRIMARY KEY (pack_id, agent_id)`（无 deployer 列、无 id 列）。
三行幂等 upsert 落库（20→23 行），`key_ref` 与各自描述符 `metadata.billing_key_ref` 一一对应：

| agent_id | key_ref |
|---|---|
| pack-wire-strategy-lab | `pk_3208cc3de4da688137419b9e` |
| pack-wire-adaptive-rotation-analyst | `pk_1bd5471a87c4154c8f72b4da` |
| pack-wire-decision-review-analyst/d1da519d4 | `pk_d6ffe0804bf44cc6596dde0e` |

key_value = token 面板新铸 `sk-` key（group 3）；写入前 `/data/facet/packs.db` 已备份
（`packs.db.bak-batch6-keys`）。

## 2. 真回合（任务 4.1）—— runner-c 内部车道

`AGENT_SERVING_BACKEND_TOKEN` Bearer → `http://100.64.0.14:<port>/`（runner-c 直连口，
取自 registry `proxy_pass_url`）`message/send`：

| 单元 | 结果 | 时长 |
|---|---|---|
| strategy-lab v7 | HTTP 200 真产物（策略四类自述） | 29.6s |
| adaptive-rotation v9 | HTTP 200 真产物（状态判定/排序/权重风控/回测四类） | 91.3s |
| decision-review v7 | HTTP 200 真产物（判定落账/持仓体检/到期结算/反思） | 61.7s |

runner-c 日志逐一确认：
`running on its own billing key (ref pk_…)` ×3 + `cold-starting … (v7/v9, harness=dsh)`。

rotation 首回合曾 `over turn budget (3m) — hard stop`（冷启动 rollover 纪要 self-turn
超预算，meter 如实记 `ok:false, budgetKill:true`），`next touch re-warms` 后重试成功——
不是部署键缺陷，保留原始记录。

## 3. 计费（任务 4.2）—— 三本账对齐

1. **runner meter**（`/data/meter.jsonl`）：三条 `kind:"message", ok:true` ——
   tokens 7797/16544/10881，durationMs 29477/91177/61529。
2. **sub2api 按 key 真成本**：`GET /v1/usage`（该 key）→ 31 requests,
   637,775 tokens, cost $0.0402, `isValid: true`。
3. **萬星 facade 外部车道分钟计费**：`POST https://wanxing.finddatatech.cloud/api/wanxing/v1/a2a/packs-_fn7pti9th5jmg3ynqut0w-pack-wire-strategy-lab`
   （caller = 该 sk- key）→ HTTP 200 / 34.8s 真产物；facade `/data/wanxing.db` 落行：

```
wu_a209c93f46f4cc3d0 | caller 2 aloadtree@gmail.com | dur 27406ms
minutes_billed=1 | rate 0.1 | settlement_status=settled | 11-07 02:18:28
```

error 回合按设计 waive（`wu_10786687e15cfcb5c` min=0 waived）——口径正确。

## 4. 出片通道（任务 2.1–2.3）

- commit `c66493f7f`（gateway/index.js knob + platform.yaml env）→ GHA image `sha-c66493f`
  → ccr relay（skopeo 验 digest）→ ArgoCD sync → platform pod
  env `FACET_PROXY_TIMEOUT_MS=120000`、`code_has_knob=2`。
- 部署 502 从 30.1s 变 120.06s：knob 生效证明；`deployToRegistry` 本身 >120s
  （每技能匿名 SKILL.md 抓取），3.1 的重跑在键已手补后不再需要。

## 5. 生产事故（本次处置，非本 change 范围但同窗口）

- cheap3 DiskPressure 复发（01:24 set）：docker prune（镜像 2.2G + build cache 1.8G）
  → 61%，`systemctl restart k3s-agent` → taint 清；facet 恢复 1/1（同时清理 2 个 Error 僵 pod）。
- **教训**：facet hostPath 卷钉死 cheap3（`/opt/platform/facet`），该节点 disk 30G 上限、
  驱逐线 ~4.6G；docker build cache 是主要可再生大头。
