# pack-marketplace Delta

## ADDED Requirements

### Requirement: Both surfaces share a type scale and spacing discipline

The two market surfaces — the facet standalone shell (`facet/web/src`) and the 壹座 embedded Store (`web/src/components/packs/`) — SHALL follow one type-scale discipline: body and explanatory text renders at `text-xs` (12px) or larger; sub-12px sizes are permitted only for non-prose micro-labels (version chips, badge numerals) and only in monospace single-line form, with the permitted inventory recorded in the shared design doc (`facet/web/DESIGN.md`). Spacing SHALL come from the semantic Tailwind scale; arbitrary-value spacing is permitted only for data-driven dimensions recorded in the same doc. The shared design doc SHALL be the single source of truth for this discipline and for the state-pattern and motion vocabulary both surfaces use.

#### Scenario: no eyeballed type sizes in prose

- **WHEN** either surface renders a paragraph, hint, or list of explanatory text
- **THEN** its font size comes from the semantic scale at 12px or larger — no `text-[9px]`, `text-[10px]`, or `text-[11px]` on prose

#### Scenario: micro-labels stay within the recorded inventory

- **WHEN** a sub-12px size is used anywhere on either surface
- **THEN** the element is a non-prose micro-label listed in the DESIGN.md inventory, rendered monospace single-line

#### Scenario: async views on both surfaces share the state pattern

- **WHEN** the 壹座 Store's market tab loads packs, or the facet shell's packs view loads packs
- **THEN** both render the same shape of skeleton/empty/error states defined by the shared design doc
