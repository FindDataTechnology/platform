# 对外披露闸 · 真机验收步骤（add-principal-disclosure-gate 6.5 / 6.6）

> 这两项在单元测试里做不到：6.5 需要真实 runner 进程跑一个回合，6.6 需要让 cell
> 真实不可达。本文是执行步骤，不是需求文档。

## 前置

```bash
# cell 侧：铸一个只给裁决端点用的令牌
export MANDATE_VERDICT_TOKEN="$(openssl rand -hex 24)"

# 配一个只到 draft 的域，确保不会自动对外发送
#   PUT /api/fleets/delegation-policy
#   { "scope": "cell",
#     "mandate": { "version": 2,
#       "domains": { "external-comms": { "mode": "draft",
#                                        "discloseScope": ["public","internal"],
#                                        "revokeWindowMinutes": 10 } } } }
```

runner 侧把同一个值注入为 `MANDATE_VERDICT_TOKEN`，并在被服务的 agent 条目上声明
`mandateDomain: "external-comms"`（未声明 = 走内部车道，不查裁决）。

## 6.6 失败关闭演练（先做这个）

**目的**：证明「取不到裁决」时什么都发不出去，而不是退回放行。

1. 不配置 `MANDATE_VERDICT_TOKEN`，或让 cell 不可达（停止 cell 进程 / 断开 runner 到
   cell 的网络）。
2. 向该 agent 发一次 `message/send`。
3. 期望：回合以 `-32013` 失败，错误文本含 `outbound withheld by disclosure gate`，
   且**对端没有收到任何文本**。
4. 反证：去掉 `mandateDomain` 声明再发一次——应当正常应答（证明是闸在拦，而不是
   runner 坏了）。

记录：两次的时间戳、错误码、对端收到的内容（应为空）。

## 6.5 门面端到端

1. 配置好令牌与 `mandateDomain`，cell 可达。
2. 发一条**干净**的 `message/send`（不含金额/人事/未公开计划）。
3. 期望：正常应答；`action_audit` 新增一行，`principal`/`audience` 有值、
   `content_digest` 为 sha256、`reversible_until` 在未来。
4. `GET /api/actions/:id/receipt` → 含授权人、代理标识、层级、时间；**不含原文**。
5. `POST /api/actions/:id/revoke` → 窗口内 200；再查 `?reversible=1` 不再包含该行。
6. 发一条**含金额**的应答（`disclose_scope` 不含 finance）。
7. 期望：回合被拦，错误里带越界项（`level=finance`, `via=pattern`），对端收不到文本。

## 流式（1.7 的边界）

1. 对声明了 `mandateDomain` 的 agent 发 `message/stream`。
2. 期望：立即返回 `-32013`，**不产生任何 delta 帧**（不是「发了一半才停」）。
3. 反证：去掉 `mandateDomain`，流式应正常（证明拒绝是车道划界，不是流式坏了）。

## 已知不做

- 平台侧不存对外发言原文（只存 digest）。争议时需要原文，从渠道（IM/邮件）取——
  那里本来就有一份。这不是缺陷，是刻意的取舍：在平台再存一份「代理以你名义说过
  的话」等于凭空造出第二个敏感面。
