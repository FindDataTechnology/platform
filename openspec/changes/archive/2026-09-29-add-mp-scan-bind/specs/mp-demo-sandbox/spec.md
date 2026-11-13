## MODIFIED Requirements

### Requirement: The client enters and leaves the sandbox deliberately

An unbound user's first launch SHALL land in the sandbox automatically: when
the silent login probe returns `binding_required` and the client knows an
accountless sandbox origin (the production build's paired demo origin), the
client SHALL switch to that origin and connect without any login and without
requiring a tap. The switch SHALL be reversible and transparent: the
previous origin is remembered, and a persistent notice identifies the demo
environment.

Leaving the sandbox SHALL stay deliberate. The in-demo notice SHALL carry a
bind call-to-action （绑定账号解锁完整功能 ›）: activating it SHALL restore
the account origin, re-boot the runtime, and open the sign-in page with
scan-to-bind ready (see `miniprogram-auth`) — one user tap from demo to a
bound account. A plain exit affordance （退出演示） SHALL also remain for
users who want the browsable unbound state on the account origin instead of
binding. The production sign-in flow SHALL behave exactly as before.

#### Scenario: an unbound reviewer taps 先体验

- **WHEN** an unbound user taps the demo entry
- **THEN** the client connects to the demo origin and chat works with no login and no authorization popup

#### Scenario: an unbound first launch lands in the sandbox

- **WHEN** an unbound user opens the mini program on a production build that pairs a sandbox origin
- **THEN** the client connects to the sandbox origin and chat works with no login, no tap, and no authorization popup

#### Scenario: the bind CTA carries the user to scan-to-bind

- **WHEN** the user in the sandbox taps 绑定账号解锁完整功能
- **THEN** the client restores the account origin, re-boots, and lands on the sign-in page with the scan action ready

#### Scenario: leaving the demo

- **WHEN** the user taps the demo notice's exit affordance
- **THEN** the client restores the production origin, re-boots, and lands in the previous unbound-notice state
