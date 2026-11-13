# a2a-agent-serving delta

## ADDED Requirements

### Requirement: Per-agent ports avoid collisions within a runner's span

A deploy SHALL resolve each serving agent's port against the occupancy of its runner slice: the hash slot when free, else the next free slot in the span, with the resolved value stamped as `port_override` in the descriptor and used verbatim in the registered URL. A redeploy of an entry that already carries a valid override SHALL keep it. A full span SHALL fail the deploy with an explicit span-exhausted error. A deploy whose registry listing fails SHALL fall back to the pure hash behavior rather than failing. A deploy with no collision SHALL add no port field and behave byte-identically to the pre-fleet contract.

#### Scenario: A colliding deploy moves to the next free slot on both ends

- **WHEN** an agent's hash slot is already occupied by another entry on the same runner slice
- **THEN** the descriptor carries a `port_override` for the next free slot and the registered URL serves from exactly that port

#### Scenario: A clean deploy adds nothing

- **WHEN** no same-slice entry occupies the hash slot
- **THEN** the descriptor carries no port field and the URL equals the hash-port form

#### Scenario: A full span fails loudly

- **WHEN** every slot of the runner's span is occupied
- **THEN** the deploy is refused with a span-exhausted error naming the runner
