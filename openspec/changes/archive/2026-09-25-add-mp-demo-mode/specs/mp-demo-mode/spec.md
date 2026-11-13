## Purpose

Gives unbound WeChat openids a real, bounded chat experience on demo-enabled
hosted deployments: a deterministically derived demo identity, an isolated
per-openid demo cell with capped concurrency and cleanup on reap, in-cell
message limits with an upgrade path, and an opt-in flag that keeps self-hosted
deployments strictly account-bound.

## ADDED Requirements

### Requirement: Demo mode is opt-in and inert without the flag

Demo auto-provisioning SHALL be disabled unless explicitly enabled by
deployment configuration. With demo mode off, every identity behavior SHALL be
identical to the account-binding contract: an unbound openid receives
`binding_required` and self-hosted single-process deployments never serve
anonymous WeChat users.

#### Scenario: flag off behaves exactly as today

- **WHEN** demo mode is not enabled and an unbound openid exchanges its wx.login code
- **THEN** the endpoint responds with the sign-in-required error and no demo identity is created

### Requirement: Demo identities are deterministic, opaque, and marker-carrying

A demo identity SHALL be derived deterministically from the openid so the same
WeChat user resolves to the same demo dataset across launches. The derived
identity SHALL NOT expose the raw openid in emails, filesystem paths, or logs,
and its token SHALL carry a demo marker group so downstream cells can apply
demo limits without any new identity plumbing.

#### Scenario: same reviewer, two launches

- **WHEN** the same unbound openid exchanges wx.login codes on two separate launches
- **THEN** both resolve to the identical demo identity (same derived email, same dataset)

#### Scenario: the openid never leaks into storage paths

- **WHEN** a demo cell is created for an openid
- **THEN** the cell's data directory name derives from the demo identity, and the raw openid appears in neither the path nor the derived email

### Requirement: Demo users land in an isolated, capped cell pool

Each demo identity SHALL resolve to its own dedicated cell — demo users SHALL
NOT share a cell, because a cell broadcasts every protocol event to all of its
connected sockets. The deployment SHALL cap the number of concurrently running
demo cells; above the cap, a new demo user SHALL receive a friendly
capacity notice instead of spawning another cell or surfacing a raw error.

#### Scenario: one stranger cannot see another's chat

- **WHEN** two different unbound openids use the mini program concurrently
- **THEN** each lands in a separate demo cell and neither's messages, sessions, nor stream events are visible to the other

#### Scenario: demo capacity is full

- **WHEN** the concurrency cap of running demo cells is reached and a new demo user connects
- **THEN** the new user receives a friendly busy notice, and no additional demo cell starts

### Requirement: Demo cells are reaped and their data deleted

Unlike resident account cells, a demo cell that stays idle past a short
configurable window SHALL be stopped, and its data directory SHALL be deleted
so curious traffic cannot accumulate garbage state. Reaping a demo cell SHALL
NOT affect account cells.

#### Scenario: idle demo cell is cleaned up

- **WHEN** a demo cell is idle longer than the demo reap window
- **THEN** the cell is stopped and its data directory is removed

#### Scenario: the demo can cold-start again after cleanup

- **WHEN** a demo user returns after their demo cell was reaped
- **THEN** a fresh demo cell starts with empty state and chat works again

### Requirement: Demo sessions enforce a message cap with an upgrade path

A cell serving a demo identity SHALL count user prompts against a per-cell
cap. Once the cap is reached, further prompts SHALL be answered with a
friendly limit reply that invites binding a real account, and the client SHALL
surface a visible demo-mode notice distinguishing the experience from a full
account.

#### Scenario: the cap answers instead of the model

- **WHEN** a demo user sends a prompt after reaching the message cap
- **THEN** the reply explains the demo limit and offers to bind an account, and no further model turn runs

#### Scenario: the reviewer knows they are in a demo

- **WHEN** a demo user opens the chat page
- **THEN** a demo-mode notice is visible without dismissing any dialog or granting any authorization

### Requirement: Binding a real account upgrades out of demo state

When a demo user redeems a bind code, the binding SHALL take effect exactly as
for any first sign-in: subsequent launches resolve to the bound account
identity and land on the account's real cell. Demo conversations SHALL NOT be
migrated into the account — the abandoned demo dataset is left to demo
reaping.

#### Scenario: demo user becomes an account user

- **WHEN** a demo user enters a valid bind code and reopens the mini program
- **THEN** the silent exchange returns the bound account identity and the user lands on their account cell with their existing data

### Requirement: The demo path collects no personal authorization

The demo experience SHALL require no authorization popup of any kind — no
phone number, avatar, nickname, or profile scope. Only the silent wx.login
exchange is used, and the mini program SHALL remain browsable with chat
usable before any optional account binding.

#### Scenario: the review pass hits zero popups

- **WHEN** a fresh WeChat account opens the mini program on a demo-enabled deployment and chats
- **THEN** no authorization dialog is ever shown and no login page is auto-opened
