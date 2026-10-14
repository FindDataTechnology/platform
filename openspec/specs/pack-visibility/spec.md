# pack-visibility Specification

## Purpose

Private packs: a creator can publish a pack without exposing it to the marketplace at large — visibility is a first-class publish field, private packs are invisible to everyone but their owner (and admins), across browsing, installing, and deploying.


## Requirements

### Requirement: Packs carry a visibility that defaults to public

A pack draft and every published version SHALL carry a visibility of `public` or `private`, defaulting to public. The field SHALL be author-controlled at publish time and immutable per published version, exactly like the rest of the frozen manifest.

#### Scenario: Publishing without choosing stays public

- **WHEN** a creator publishes a draft that never set visibility
- **THEN** the published pack is public and listed as before

#### Scenario: A private publish is honored

- **WHEN** a creator publishes with visibility private
- **THEN** the stored version records private and the marketplace does not list it to other users

### Requirement: Private packs are owner-scoped everywhere

A private pack SHALL be invisible in browse, search, and detail to every user except its owner and admins; install and deploy SHALL be refused for anyone else with the same not-found answer a nonexistent pack gives (probing teaches nothing). The owner's own views SHALL badge the pack as private.

#### Scenario: A stranger cannot see or reach it

- **WHEN** a non-owner lists, searches, opens the detail of, installs, or deploys a private pack
- **THEN** every surface answers as if the pack did not exist

#### Scenario: The owner sees and uses it

- **WHEN** the owner (or an admin) browses or opens the private pack
- **THEN** it is listed with a private badge, installable, and deployable under the same gates as public packs

### Requirement: Registry assets follow the pack's visibility

The deploy action SHALL register the pack's registry skill entries and a2a agent entry with matching restricted visibility, so a private pack's agents are discoverable only to their owner (and admins) on the registry's discovery surfaces.

#### Scenario: A private deploy stays undiscoverable

- **WHEN** a private pack's serving-contract agent is deployed
- **THEN** its registry entries are not publicly listed, while the owner's calls are served as usual
