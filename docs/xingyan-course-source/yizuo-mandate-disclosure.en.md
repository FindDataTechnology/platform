---
title: "Let the agent decide for you: the three dials of a mandate"
summary: "Configure, per business domain, how far the agent may act, within which quota, and across which two information scopes. Afterwards you can decide whether to let it speak outward by looking at evidence instead of instinct."
order: 14
level: use
updated: '2026-11-09'
source_material: "Yizuo 1.3.x mandate and disclosure-gate implementation (openspec agent-personal-mandate / agent-personal-deputy / principal-disclosure-accountability, archived 2026-11-09); real-machine acceptance runs 15 assertions (scripts/verify-mandate-acceptance.mjs)"
pack_url: ""
---

## What you can do afterwards

Three things hold once the four domains are configured:

- Every domain in the "Mandate" pane has its own decision mode, daily action cap and revoke window; domains you never configured are labelled "Advise only";
- Every source in the "Matter intake" pane has its own switch, and a switched-off source sends matters into no domain at all;
- Two evidence panels carry real numbers — behavioural consistency and outbound samples per disclosure level — which is what you use to decide whether a domain may move from "draft" to "act, then report".

## Prerequisites

| Item | Requirement | What you see if it is missing |
|---|---|---|
| Yizuo | You can open Settings → Management → "Mandate" | The sidebar has no "Mandate" or "Matter intake" entry |
| Account | The deployment owner | The pane loads but saving returns 401 |
| One enabled domain | At least "Team operations" or "External comms" | All four domains stay at "Advise only" and cannot be raised |

The examples below use "Team operations" and "External comms". Swapping in "Advancing work" or "Research output" changes the steps not at all.

## Terms

This course uses only the "Wording used here" column. One concept gets one name: readers and retrieval both key off the word.

| Concept | Wording used here |
|---|---|
| The authorization that decides how far the agent may act in a domain | mandate |
| The four configurable business scopes | domain |
| Advise only / draft / act then report / autonomous | decision mode |
| The set of information levels the agent may read | read scope |
| The set of information levels the agent may say outward | disclose scope |
| The agent post that rules on the team's internal decision queue | deputy |
| Which matters enter which domain | matter intake |

## Steps

### 1. Separate "who rules" from "how far it may act"

"Decision delegation" answers **who** rules on the team's internal items. "Mandate" answers **how far the agent may act**. They are configured separately: the former governs routing and a daily ruling budget, the latter governs modes, quotas and information scopes.

**Input**: you can open the settings panel.
**Action**: open "Settings → Management" and confirm you see both "Decision delegation" and "Mandate".
**Output**: both panes are listed, with "Mandate" after "Decision delegation".

![Decision delegation: this pane configures "who rules" — category routing, severity ceiling, daily ruling cap; it says nothing about how far the agent may act](media/yizuo-mandate-disclosure/03-delegation.png)

### 2. Give one domain a decision mode and a quota

![The mandate pane: four domains, one row each; "Team operations" and "External comms" are set to "Draft, wait for me" with a quota and revoke window; "Advancing work" is still "Advise only"](media/yizuo-mandate-disclosure/01-mandate-domains.png)

The four modes differ in exactly one thing: **may the agent act without waiting for you**.

| Decision mode | What the agent does | When you would use it |
|---|---|---|
| Advise only | Returns a judgement, produces no executable action | Default for a new domain; still observing |
| Draft, wait for me | Produces an editable draft; nothing is sent until you release it | Saving effort without handing over control |
| Act, then report | Acts immediately, notifies you right after, offers a revoke window | The wording has been confirmed repeatedly |
| Autonomous, digest only | Acts immediately without interrupting you | High volume, low risk, revocable |

**Input**: the settings panel from step 1.
**Action**: on the "External comms" row, set "Decision mode" to "Draft, wait for me", "Daily action cap" to `3`, "Revoke window (min)" to `10`, then click "Save".
**Output**: a "Saved" confirmation appears; reloading the page shows the same values.

Quota only ever tightens: **when it runs out the domain drops one mode step down**, never up. Leaving the revoke window empty means the action cannot be recalled — and a non-revocable action is never executed automatically.

### 3. Tick the two scopes separately

![One domain in full: decision mode, daily cap, expiry, revoke window, and below them the two independently ticked scopes](media/yizuo-mandate-disclosure/05-scopes-one-domain.png)

This is the most overlooked part of the whole configuration: **letting the agent read a piece of information does not let it say that information outward**. The two sets are judged independently.

**Input**: the domain configured in step 2.
**Action**: tick `Internal` under "May read"; keep only `Public` under "May disclose".
**Output**: the two rows show different tick states. From then on the agent can read internal material, but any outbound draft that quotes it is withheld with a named violation.

### 4. Decide which matters are allowed in

![Matter intake: three sources, one row each, all switched off by default; the right side shows which domain each source feeds](media/yizuo-mandate-disclosure/02-matter-intake.png)

The switch only decides **whether a matter gets in**, not how far the agent may act — that is still step 2's mandate. Everything starts switched off, so an upgrade never hands personal matters to the agent by surprise.

**Input**: a configured domain.
**Action**: in "Matter intake", switch on "Cross-line blockers".
**Output**: the row shows the switch on; from then on those matters follow the "Team operations" domain's current mode.

### 5. Read both evidence panels before raising autonomy

![The evidence panels under Matter intake: consistency and comparable samples per domain, outbound samples per disclosure level, and which level is still blocking auto-send](media/yizuo-mandate-disclosure/02-matter-intake.png)

Raising autonomy is not a matter of instinct. Two numbers must be read together:

| Number | Where | What it answers |
|---|---|---|
| Behavioural consistency | "Behavioural consistency" under Matter intake | How often the agent's judgement matched what you actually decided |
| Level samples | "Outbound samples per disclosure level" in the same pane | How many times you have actually validated that disclosure level |

When samples are short, setting the mode to "Act, then report" is refused by the server, and the response names the missing level. That is deliberate: **getting internal wording right does not support quoting prices automatically**.

### 6. Look at one real withholding result

![A real verdict response: decision=draft with a finance violation hit by pattern](media/yizuo-mandate-disclosure/04-verdict-blocked.png)

When a message that is about to go out crosses the scope, the response names the level and how it was hit — not a generic "blocked".

| Hit kind | Meaning |
|---|---|
| `provenance` | It drew on memory or precedent outside the read scope |
| `pattern` | The text contains a recognisable pattern such as an amount |
| `term` | The text contains a configured sensitive term |

**Input**: a domain whose "May disclose" set contains only `Public`.
**Action**: have the agent draft an outbound reply that quotes a price.
**Output**: the action falls back to a draft, and the response carries `finance` and `pattern`. Remove that passage and retry; it passes.

## When it does not work

| Symptom | Cause | Action |
|---|---|---|
| The "Mandate" pane stays at `Loading…` | The first data request has not returned yet | Wait a few seconds; if it is still empty after 30 s, reload. A pane that exists but stays empty is the real fault |
| Saving returns 400 mentioning unknown domain | The domain name in the request is misspelled | The four legal domains are `ops`, `external-comms`, `advancement`, `research`; nothing else is accepted |
| Setting a domain to "Act, then report" is refused | Consistency or level samples are insufficient for that domain | Keep it at "Draft" for a while; check which level the evidence pane names |
| The channel cannot recall a message | The channel declares itself non-revocable | That channel caps at "Draft". An unrecoverable automatic send is just a notification of an incident |
| A source is switched on but nothing arrives | The target domain is still "Advise only" | The switch only controls entry; raise the domain to "Draft" first, per step 2 |

## Self-check

All three are checkable against a known answer:

1. Open "Mandate": any unconfigured domain must read "Advise only" with an empty quota — a number in the quota field means it was configured.
2. Open "Matter intake": the three switches must show the state you last saved; switch "Cross-line blockers" off, reload, and it must stay off.
3. Trigger one outbound message containing an amount: the response must name `finance`; delete the amount and retry, and it must pass.

## Next

- To let the agent take on more matter types: raise the domain to "Draft" first, collect consistency, then talk about autonomy.
- To let the agent speak on your behalf outward: watch "Outbound samples per disclosure level" — each level must collect its own samples before auto-send is allowed.
- Team structure and cadence live in "Decision delegation" and the fleet cockpit; this course only covers the authorization layer.
