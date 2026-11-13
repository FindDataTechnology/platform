# Tasks: add-ciyuan-capability-contract

> 本 change 只落契约（spec delta + 索引），不改代码、不动 fork 仓、不动既有 `ciyuan-*` 契约。
> 双账纪律：第 3 节的接入项各自在独立 change 内完成并勾选，禁止在本单里代勾。

## 1. 契约自身（本单内完成）

- [x] 1.1 `specs/ciyuan-capability-endpoint/spec.md`：消费方视角四条 Requirement（可依赖语义 /
  禁止五条推断 / 降级义务 / 双仓一致性），每条带 Scenario——验证：`openspec validate --strict` 通过
- [x] 1.2 `proposal.md`：Why（三条现况痛点 + 与既有五条 ciyuan-* 的同与不同）、What Changes、Impact——验证：四节齐备
- [x] 1.3 `design.md`：D1-D4 + 风险 + 零运行时变更声明——验证：每条决策含被否备选与理由
- [x] 1.4 终验：`openspec validate add-ciyuan-capability-contract --strict` exit=0——验证：2026-11-10 实跑 `Change 'add-ciyuan-capability-contract' is valid`，exit=0

## 2. 与生产者侧的一致性（跨仓，需在 fork 侧有对应物）

- [x] 2.1 对照基线登记：fork 仓 `add-ciyuan-capability-endpoint`（2026-11-10，代码面完成未上产）为本契约的生产者侧——验证：本文件与 proposal 均引用该 change 名
- [ ] 2.2 上产后再核对一次：端点真机返回的字段集合与本文「可依赖字段」表逐项吻合——验证：真实 key 请求的 JSON 键集合 ⊆ 本文表格列出的语义域；差异项须修订本文或 fork spec（另立修订 change）

## 3. 消费方接入（不在本 change；各自独立立单）

- [ ] 3.1 可选：双仓一致性审计只读门（仿 `fd-industry-data/scripts/conformance_gate.py`）——验证：能对两侧 spec 做「同一字段表述是否可同时为真」的检查并点名漂移项
- [ ] 3.2 壹座：`POST /api/llm/providers/:id/sync` 改「读快照为主、探测为校验」，`VOLCES_MODELS` 降为回退锚——验证：新 change 内 tasks 勾选 + 分歧告警可观测
- [ ] 3.3 各线：时论/之思/正信/柏讯默认模型改「读 `serving` 里自己的偏好、失败回落硬编码」——验证：四条线各一次真调用成功；词元不可达时回落不报错
