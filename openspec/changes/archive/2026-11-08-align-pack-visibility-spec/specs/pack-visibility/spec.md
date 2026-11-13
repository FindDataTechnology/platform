# pack-visibility 可见性回写

## MODIFIED Requirements

### Requirement: Packs carry a visibility that defaults to public

A pack SHALL carry a visibility of `public` or `private`, defaulting to public.
Two layers hold it, and they are not the same thing:

- The **frozen version manifest** carries the `visibility` the publisher chose.
  That field is immutable per published version, exactly like the rest of the
  manifest — republishing never rewrites an existing version.
- The **pack-level effective visibility** (`packs.visibility`) is what every
  surface reads — listing, search, detail, badge, install, deploy. It starts as
  the published manifest's value and MAY afterwards be flipped by the pack's
  author or an admin (`PUT /api/packs/:id/visibility`), because a creator who
  mis-set exposure needs a way back without republishing. A flip is a
  pack-attribute change, not a new version: version numbers, manifests, and
  publish history stay untouched.

#### Scenario: Publishing without choosing stays public

- **WHEN** a creator publishes a draft that never set visibility
- **THEN** the published pack is public and listed as before

#### Scenario: A private publish is honored

- **WHEN** a creator publishes with visibility private
- **THEN** the stored version records private and the marketplace does not list it to other users

#### Scenario: The author or an admin flips visibility after publish

- **WHEN** the pack's author (or an admin) calls `PUT /api/packs/:id/visibility` with `public` or `private`
- **THEN** the pack-level effective visibility changes and every surface follows immediately — a pack flipped to public appears in the marketplace, one flipped to private disappears from other users' views
- **AND** the already-published versions keep their frozen manifests byte-for-byte, and no new version is created
- **AND** a caller who is neither the author nor an admin is refused (403), and a value other than `public`/`private` is refused (400)
