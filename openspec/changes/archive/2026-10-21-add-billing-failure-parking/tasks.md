## 1. Park core (manager state + fail-fast)

- [x] 1.1 `agent-runner/manager.js`: `#parked` map (`{reason, detail, since}`) + pin record per role (`{keyValue, baseUrl, providerType}`) captured at `applyBillingKey` time and on the runner-level fallback; a re-materialized role (identity/respawn path) clears both — unit: pin then respawn clears, record refreshed from the new ref（apply 注记：清停车定在 reconcile 身份变更缝——turn() 在 acquire 前就被停车闸挡住，spawn 自身清不了；billing_key_ref 入 #identityOf，纯换绑才真正重组，同 secretRefs 纪律）
- [x] 1.2 `manager.turn()`: after the `pausedKeys` check (pause wins precedence), a parked role throws `{ code: -32012, message: "agent parked: <reason> (<detail>) since <time>" }` before any acquire/probe/LLM work — unit: parked role's inbound turn rejects `-32012` with both reason and timestamp in the message, no child spawn（码更正：-32011 已被 a2a 委派深度上限占用，取下一空闲码 -32012）
- [x] 1.3 `agent-runner/config.js`: `billingParkEnabled` (`AGENT_RUNNER_BILLING_PARK`, default on — off disables probe + park entirely) and `billingReprobeSecs` (`AGENT_RUNNER_BILLING_REPROBE_SECS`, default 600) — unit: env parsing both shapes, off honored at every gate below

## 2. The classifier probe (D1)

- [x] 2.1 Probe helper in `manager.js`: `GET {baseUrl}/models` with the role's pinned key, 10 s timeout, per-key in-flight guard, 60 s per-key floor; mapping — 401/403 + `code:"INVALID_API_KEY"` → `key-invalid`, 403 + `code:"INSUFFICIENT_BALANCE"` → `insufficient-balance`, 200/transport/other → no park; provider type gate: only `openai-completions` ever probes — unit: all four probe outcomes drive the right park decision; a non-openai provider never probes（复探侧 2xx 才算 pass：5xx/其他状态/传输错一律 undecided——不停也不复业）
- [x] 2.2 Trigger: on a turn failure with `e.code === -32003` (message-agnostic), fire the probe once; a park result writes `#parked` and emits `billing_parked {reason, detail, since}` — unit: a `-32003` failure under an exhausted-key fake probe parks on the first failure and the meter still records that failed turn exactly once

## 3. Seams, timer, events, health

- [x] 3.1 Skip seams: `scheduler.js` tick and `rollover.js` `check()` skip parked roles beside the existing `pausedKeys` checks — unit: a parked role's digest is not retried by the next 60 s check (the storm shape), self-turns do not fire
- [x] 3.2 Re-probe timer in `index.js` (cadence from config, probes only parked roles, probe pass → delete entry + emit `billing_unparked {reason}`); kill-switch off → timer unarmed — unit: fake probe pass unparks and the next scheduled turn proceeds
- [x] 3.3 Fleet + health: both events ride the existing bus (`budget_killed` precedent); health rows for a parked role carry `parked: {reason, since}` while the lifecycle-state vocabulary stays untouched — unit: health snapshot shows the annotation alongside, not instead of, the five states

## 4. Scenario sweep (spec coverage)

- [x] 4.1 `scripts/test-agent-serving-billing-park.mjs` covering every spec scenario: park-after-first-failure, `-32012` fast-fail (send + stream shapes), invalid-key reason distinct from insufficient-balance, recharge auto-resume, probe-200 flake never parks, re-pin clears park, pause-then-resume leaves park gating, fresh manager instance (restart bound) re-parks after one failed turn, unprobeable provider keeps legacy behavior, health annotation

## 5. Gate + rollout

- [x] 5.1 Full local gate: `node --test scripts/test-*.mjs` green with the new suite included, existing suites untouched; `openspec validate add-billing-failure-parking --specs --json` green（实证：全量 1757/1758——唯一红是 HEAD 上既有缺陷，`scripts/test-official-packs-lint.mjs` 仍断言 tool_risk 12 条而 `lib/wire-tool-risk.js` 已在 7c6bc0b9 长到 14（add-pack-subscribe-actions 欠的同步），与本 change 无关、两文件均无工作区改动；change 自身 validate 绿 1/1，--specs 全量里另 4 红=knowledge 组空 spec 旧债）
- [x] 5.2 Serving image release + roll; live acceptance: drain one test deployment's sub2api key to zero → one failed turn → `billing_parked` in events, inbound `-32012` with readable reason, logs silent on subsequent ticks; recharge → `billing_unparked` within one cadence and the next turn succeeds; record the run in the ledger (`docs/registry-maintenance.md` §9 or the serving ledger section)（实证 2026-10-21：镜像 sha-839f39c/digest b35419e1 只滚 agent-runner-serving 双 image 行，GitOps 53634af；验收对象「一键流验收」代理（deployer aloadtree）：清零 1.95984848 → 一回合 -32003 即停车+事件 → 入站 -32012 人话 → 95s 静默窗 meter 零新增 → 回填 → 480.9s 自动复业+`billing_unparked` → 下一回合 7379 tokens 真成功；台账 §15.2）
