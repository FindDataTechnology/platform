# require-full-access-ack

## Why

`danger-full-access` is the one preset that disables the sandbox and the approval
prompts — the agent then runs with the host's own rights. The product already
guards it, but only in ONE place: `web/src/components/ControlStrip.tsx`'s
`FullAccessDialog` refuses to send `set_permission` until the acknowledgement
checkbox is checked. That is a **client-side convention**.

The server does not verify it. `server/ws.js`'s `set_permission` handler forwards
`data.name` straight to `ctx.switchPermissionTo(...)`, which validates the
streaming state and the roster — nothing about acknowledgement. So anything that
speaks the WS protocol with a valid identity (a script, an integration test, a
future second client) escalates the shared runtime to full host access with no
acknowledgement anywhere in the system. The spec's requirement is written
against "the client", so this is not a spec violation — but the requirement's
**intent** (a human saw the risk) is unenforced on the side that actually holds
the capability.

Not a role problem, and this change deliberately does not become one: the WS
upgrade is already authenticated (`authorizeUpgrade` → 401), and preset state is
documented deployment-global state that any authenticated user may manage (v1
ceiling, `server/routes/custom-presets.js` header). What is missing is narrower —
**the acknowledgement must travel with the request**, so bypassing the UI cannot
bypass the gate.

## What Changes

- **Wire contract**: `set_permission` accepts an optional `acknowledge: true`.
  The full-access switch requires it; every other preset ignores it.
- **Server gate**: `switchPermissionTo(name, { acknowledge })` refuses
  `danger-full-access` unless `acknowledge === true`, returning an error to the
  requesting client only (the existing orphan-error path — toast, state
  unchanged). The check sits AFTER roster validation, so an unknown name still
  reports "unknown" rather than masking as an acknowledgement problem, and a
  deployment that composes no full-access preset keeps saying so.
- **No-op stays a no-op**: if the live session is already on
  `danger-full-access`, a repeat request is not a new escalation and does not
  demand the flag.
- **Client**: the confirm action in `FullAccessDialog` sends
  `{ acknowledge: true }` — the flag is produced by the same action that was
  disabled until the checkbox was checked, so the client contract is unchanged
  from the user's point of view.
- **Tests**: the unit suite covers refusal-without-flag, acceptance-with-flag and
  error precedence; the e2e suite pins the flag on the wire.

## Capabilities

### Modified Capabilities

- `permission-mode-selection`: the full-access acknowledgement becomes a
  server-enforced precondition of the switch, not only a client dialog; the
  `set_permission` payload gains the optional `acknowledge` field.

## Impact

- **Server**: `server/ws.js` (one handler passes the flag),
  `server/agent-session.js` (`switchPermissionTo` gains the gate).
- **Client**: `web/src/components/ControlStrip.tsx` (one send site),
  `packages/core/src/types/ws.ts` (payload type).
- **Tests**: `scripts/test-permission-switch.mjs` (three cases),
  `e2e/composer-controls.spec.js` (asserted payload shape).
- **Compatibility**: the client and server ship in the same image (no version
  skew), and `set_permission` has exactly one producer in the tree. A raw client
  that omits the flag now gets an error instead of host access — which is the
  point of the change.

## 非目标

- 不引入角色/管理员授权：部署级全局态由任意已登录用户管理是书面 v1 上限
  （`custom-presets.js` 头注释，与预设选择同类），改这一点是产品裁决，不在本 change。
- 不改其他预设（`read-only` / `workspace-write` / 自定义）的行为：它们不带
  主机逃逸语义，仍即时生效。
- 不改 `set_preset` / `set_model` / `set_workspace` 的语义。
- 不为 `danger-full-access` 增加二次密码或审计行——需要另立 change。
