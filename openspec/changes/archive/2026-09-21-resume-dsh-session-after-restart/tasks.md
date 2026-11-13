# Tasks: resume-dsh-session-after-restart

## 1. Probe API groundwork

- [x] 1.1 Read the installed `@deepseek-ai/dsh-session-persistence` service
  surface (resolve the design's open question: the exact stored-log probe —
  `loadStored(id)` shape vs a lighter `has`), and write the finding as a
  short comment in the bridge template. Verify by resolving the service from
  a booted child (one-off script) and printing the probe's answer for one
  persisted and one fresh session id.

## 2. Bridge: resume-or-create

- [x] 2.1 Extend `dsh-profile-template/platform-preset-bridge.js`
  `createSession`: probe persisted → `agents.resume({ resumeSessionId,
  agentOptions, setup })` with the same preset mount as create; unpersisted →
  existing create path unchanged; probe service absent → today's behavior.
  Verify: `node --check` on the template and the child-level script from 3.1
  turns red→green.
- [x] 2.2 Boot smoke: restart the dev server and confirm
  `[dsh-profile] wrote preset bridge …` still appears (the template still
  copies + composes), the runtime boots, and a fresh-session turn behaves as
  before.

## 3. Tests

- [x] 3.1 `scripts/test-session-resume.mjs` (dummy LLM): spawn the platform
  child via HarnessClient, prompt session `S` (turn fails on the LLM, but the
  user-message append persists the log), SIGKILL the child, respawn, prompt
  `S` again — assert the second turn's error is the LLM one, NOT an
  id-collision. Also cover the torn-tail variant (kill mid-first-turn) and a
  never-persisted id (create path, unchanged). Verify:
  `node --test scripts/test-session-resume.mjs` green.
- [x] 3.2 `e2e/session-resume.spec.js` (fast project, dummy LLM): boot, apply
  a user turn (persist the session), switch model via `set_model` (child
  restart), send another turn — assert the WS error (if any) is the LLM
  failure and the turn does not end with the id-collision message; assert a
  fresh session after the restart still works. Verify:
  `npx playwright test e2e/session-resume.spec.js --project=fast`.
- [x] 3.3 `@smoke` context-preservation spec (`e2e/session-resume-smoke.spec.js`):
  tell the agent a name, `set_model` restart, ask for the name — assert the
  answer contains it. Verify:
  `npx playwright test e2e/session-resume-smoke.spec.js --project=smoke`
  (real LLM; free-model 503s are retried once before failing the spec).
- [x] 3.4 Full gates: `npm run test:unit` (168+ green) and
  `npm run test:e2e` — no new failures beyond the known flaky pair
  (chat-polish 8.3b/8.4) and the known pre-existing sso-user-bindings case.

## 4. Spec sync

- [x] 4.1 On completion, sync the delta into
  `openspec/specs/dsh-runtime-bridge/spec.md` (the ADDED requirement plus the
  MODIFIED preset-mount requirement with its new resume scenario) — via the
  archive workflow, keeping scenario text byte-identical to the delta.
