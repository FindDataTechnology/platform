# agent-runner Specification (delta)

## ADDED Requirements

### Requirement: Billing classification accepts an out-of-band rejection shape

The runner SHALL treat a failed turn as a billing-classification candidate when either the turn surfaced the LLM-failure code, or the error carries a rejection shape that the model client raises outside the streamed failure frame — an HTTP status of 401 or 403 on the error object, or a message bearing the client's `<status> status code` form. Being a candidate SHALL only authorise the existing zero-spend key probe; the park decision SHALL remain the probe's alone.

When a candidate probe does not report a rejection, the runner SHALL leave the role unparked and its behaviour identical to before this requirement, and SHALL record that the shape was seen without a confirmed rejection.

#### Scenario: An out-of-band 403 reaches the probe and parks

- **WHEN** a turn fails with a model-client error whose status is 403 and whose message is the client's `403 status code` form, and the zero-spend probe reports the pinned key rejected
- **THEN** the role is parked exactly as it is for an LLM-failure turn, and the park event carries the probe's reason

#### Scenario: A rejection shape that the probe clears does not park

- **WHEN** a turn fails with a 401/403-shaped error but the probe passes
- **THEN** the role is not parked, the turn keeps the behaviour it had before this requirement, and the shape is recorded as unconfirmed rather than as a rejection

#### Scenario: A probe that cannot decide does not park

- **WHEN** a candidate's probe fails for transport reasons, returns an indeterminate verdict, or targets an unprobeable provider
- **THEN** the role is not parked

#### Scenario: The code path keeps working unchanged

- **WHEN** a turn fails with the LLM-failure code and the probe reports a rejection
- **THEN** the role parks exactly as before this requirement

### Requirement: Failed turns carry an error kind

The `turn_ended` payload of a failed turn SHALL carry an `error_kind` drawn from the forms the runner can name at emit time — the failure code's class, or the unconfirmed rejection shape — and SHALL omit the field when no form applies rather than guessing one. A confirmed billing rejection SHALL NOT be reported on `turn_ended`, because confirmation happens after the event is emitted; it is carried by the park event instead. Successful turns SHALL NOT carry the field, and consumers that do not know it SHALL be unaffected.

#### Scenario: A failed turn names its class

- **WHEN** a turn fails with the LLM-failure code
- **THEN** its `turn_ended` carries `error_kind` naming that class

#### Scenario: A rejection shape is named as unconfirmed

- **WHEN** a turn fails with a 401/403 shape and the probe does not confirm a rejection
- **THEN** its `turn_ended` carries the unconfirmed-rejection kind

#### Scenario: The confirmed verdict rides the park event

- **WHEN** a probe confirms the pinned key was rejected
- **THEN** the park event carries the reason, and the already-emitted `turn_ended` did not claim a confirmation it could not have had

#### Scenario: An unnameable failure omits the field

- **WHEN** a turn fails with an error matching no named form
- **THEN** `error_kind` is absent from the payload rather than null or a placeholder

#### Scenario: Successful turns are untouched

- **WHEN** a turn succeeds
- **THEN** its `turn_ended` carries neither `error_kind` nor any other new field
