## ADDED Requirements

### Requirement: Curated pinned sources declare their entries and pin a commit

The external shelf SHALL support a curated source class whose entries are chosen by an operator rather than discovered by search. A curated source SHALL pin its upstream at a named commit revision (not a branch or tag), SHALL carry only operator judgement per entry (identifier, upstream path, intent, tags) and SHALL NOT carry skill bodies, so that a listing can never drift from the content it claims to describe. Content SHALL be fetched from the pinned revision at list/package time, and the resulting shelf entry's origin URL SHALL name that pinned revision — which is also what makes the same entry adoptable through the existing official-adoption path with no additional plumbing.

#### Scenario: curated entries resolve at the pinned revision

- **WHEN** a curated source lists or resolves an entry
- **THEN** the issuing origin URL names the pinned commit revision, so the content behind it cannot move when the upstream branch advances

#### Scenario: a curated source carries no skill bodies

- **WHEN** an operator inspects the curated source declaration
- **THEN** it contains only entry identifiers, upstream paths and intent text — the body text lives upstream and is fetched per request

#### Scenario: branch-pinned curated sources are refused

- **WHEN** a curated source declares a branch name or tag as its revision instead of a commit sha
- **THEN** the declaration is rejected as non-pinnable rather than silently resolved at request time

### Requirement: Curated sources structurally exclude non-redistributable upstream entries

A curated source SHALL admit only entries whose upstream license permits redistribution. Entries whose upstream is proprietary, all-rights-reserved, or carries no license declaration at all SHALL be excluded from the declaration itself — not merely blocked by a runtime gate — so that a listing cannot offer an install that the license gate would refuse. Entries that exceed the platform's own package limits SHALL likewise be omitted rather than listed as an install that always fails.

#### Scenario: proprietary upstream entries are never listed

- **WHEN** an upstream repository ships some permissively licensed skills and some proprietary ones
- **THEN** the curated declaration lists only the permissive ones, and the proprietary ones cannot be reached as shelf entries at all

#### Scenario: an entry that cannot fit the package limits is omitted

- **WHEN** a candidate's upstream directory exceeds the platform's auxiliary-file or size limits
- **THEN** it is left out of the declaration instead of being offered as an install that always fails
