# personal-data-rights Specification

## Purpose
TBD - created by archiving change add-personal-data-export. Update Purpose after archive.

## Requirements

### Requirement: A user can export the personal data the platform holds about them

The platform SHALL expose a read-only export of the personal data it holds for
the authenticated caller, keyed strictly by that caller's identity — never by an
identity supplied in the request. The export SHALL include the caller's rows
from every personal table (the ones keyed by email: model and MCP bindings,
registry / connector / search / facet-device / paper-trading / line / 词元
credentials) and their session OWNERSHIP facts (id, title, timestamps,
workspace, message count).

The export SHALL NOT include deployment-global state, because it is not an
individual's data: the preference key/value table (whose keys are runtime
settings such as the agent preset and per-provider effort), the shared custom
preset roster, and the lineage-keyed chart bindings. The export SHALL NOT
include message bodies: conversation content belongs to the session archive, and
copying it here would silently turn an export into a transcript dump.

Credential-shaped values SHALL be masked in the export — the export is a record
of what is held, not a second copy of the secrets. A personal table that this
deployment never populated SHALL degrade to an empty list instead of failing the
export, and the response SHALL state its own scope so a reader cannot mistake it
for a complete account archive.

#### Scenario: the export answers for the caller only

- **WHEN** an authenticated caller requests their export
- **THEN** the response contains that caller's rows and returns nothing belonging to another identity, regardless of any identity named in the request

#### Scenario: credentials are recorded but not disclosed

- **WHEN** the caller holds a credential row (for example a registry token)
- **THEN** the export reports that a value is held, and the value itself does not appear anywhere in the response body

#### Scenario: deployment-global state is excluded

- **WHEN** the export is produced on a deployment that has preferences, custom presets and chart bindings
- **THEN** none of those appear as personal data, and the response names them among its exclusions

#### Scenario: session ownership without conversation content

- **WHEN** the caller owns sessions containing messages
- **THEN** the export lists those sessions with their metadata and message COUNT, and no message body appears in the response

#### Scenario: an unused lane does not fail the export

- **WHEN** one of the personal tables does not exist in this deployment
- **THEN** the export still answers, with an empty list for that lane

#### Scenario: the export is closed to anonymous callers

- **WHEN** a request arrives without an identity, or the database is unavailable
- **THEN** the response is 401 and 503 respectively, and no data is returned

### Requirement: A user can erase their personal data without destroying shared conversation content

The platform SHALL let an authenticated caller erase the personal data it holds
about them: their rows in every personal table (the same allowlist the export
reads, so a column can never be exported but forgotten on erase) and their
session OWNERSHIP — because ownership is itself a personal fact ("this identity
ran these turns").

Session rows and their messages SHALL survive an erase: a transcript may be
material a teammate still reads, and a user asking for their personal data to go
is not asking for shared history to vanish. Deployment-global state SHALL be
untouched, because it was never the individual's data.

The request SHALL require an explicit confirmation token
(`{ "confirm": "erase" }`); without it the platform SHALL refuse with 400 and
state the scope it would apply, so a destructive call cannot fire on a bare
DELETE or on a stale retry. The response SHALL report per-table deletion counts
and the number of detached sessions, so the caller can verify what happened
instead of trusting it.

#### Scenario: a bare request is refused with its scope stated

- **WHEN** a caller sends the erase request without the confirmation token, or with any other value
- **THEN** the platform refuses with 400, erases nothing, and names what it would delete, detach and keep

#### Scenario: personal rows are erased and ownership detached

- **WHEN** a caller erases with the confirmation token
- **THEN** their rows are gone from the personal tables and their sessions carry no owner

#### Scenario: conversation content survives

- **WHEN** a caller who owns sessions with messages erases their personal data
- **THEN** those session rows and their messages still exist and remain readable, with no owner attached

#### Scenario: deployment-global state is untouched

- **WHEN** an erase runs on a deployment with preferences, custom presets and chart bindings
- **THEN** none of them change

#### Scenario: the response reports what happened

- **WHEN** an erase completes
- **THEN** the response carries per-table deletion counts and the number of detached sessions
