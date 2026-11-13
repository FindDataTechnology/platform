# browser-use Specification（delta）

## REMOVED Requirements

### Requirement: Each cell owns one shared browser state

**Reason**: 共享车道（slim-browser-lane-footprint）把「每 cell 一个浏览器进程」换成
「每 pod 一份进程 + 每会话一个浏览器上下文」。旧要求把「同一 cell 跨会话保持登录」写成
必需行为，而该行为依赖一份落盘的 profile；在 pod 级共享进程上，落盘 profile 就是一份
跨 cell 可读的磁盘状态，正是本变更要削掉的形态（裁决 2026-11-08：隔离粒度改为每会话）。
取代它的新要求见下（`Each cell owns one browser state per session`）。

## ADDED Requirements

### Requirement: Each cell owns one browser state per session

Where the lane is local, browser state (tabs, cookies, login state) SHALL persist for
the duration of one session of the owning cell, and SHALL NOT cross cells: two users'
cells SHALL hold independent browser state. Isolation SHALL be carried by a per-session
browser context, not necessarily by a separate browser process — a pod may serve several
cells from one shared browser runtime and one shared driver process, provided each
session's context stays invisible to the others. A later session of the same cell MAY
start with a fresh context and no login carried over: the shared lane never writes a
browser profile to disk. `BROWSER_LANE=off`, the local/remote/absent supply gate, and
the no-silent-redispatch rule for a failed remote endpoint SHALL be unchanged.

#### Scenario: login persists within one session

- **WHEN** an agent logs into a site and a later prompt in the SAME session revisits that site
- **THEN** the site SHALL present as logged in, without extra configuration

#### Scenario: a new session of the same cell starts clean

- **WHEN** a session of a cell ends and a new session of the same cell revisits that site
- **THEN** the site MAY present as logged out
- **AND** no other cell ever observes that login

#### Scenario: no cross-cell leakage

- **WHEN** two hosted cells use the browser lane in the same pod
- **THEN** each cell's browser state SHALL remain invisible to the other (cookie, login state, tabs, artifacts), regardless of whether the two cells share one browser process

#### Scenario: supply gate unchanged

- **WHEN** a deployment supplies a local runtime but sets `BROWSER_LANE=off`, or supplies nothing at all
- **THEN** the lane's entry SHALL be omitted from the generated patch exactly as before
