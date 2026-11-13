## ADDED Requirements

### Requirement: The chat viewport is fixed to the browser viewport

The chat surface at `/chat` SHALL occupy exactly the browser viewport height. The sidebar column, message log, and composer SHALL fit inside the viewport at all times; the browser window itself SHALL NOT gain a page-level vertical scrollbar as chat turns accumulate.

The message log SHALL be the only vertically scrolling region on the chat page. Its intrinsic minimum height SHALL NOT be allowed to expand its ancestors — parent flex/grid tracks that contain the scroller SHALL declare `min-height: 0` (or equivalent) so `overflow-y` engages instead of pushing content past the viewport.

The composer SHALL remain visible at the bottom edge of the viewport regardless of message-log content length. It SHALL NOT be inside the scrolling region.

The empty-state placeholder (shown when there are no turns) SHALL be laid out inside the scrolling log so that it does not shift the composer's vertical position.

#### Scenario: Long transcript keeps composer pinned
- **WHEN** the message log contains enough turns that its content exceeds the viewport height
- **THEN** the log scrolls internally and the composer stays anchored to the bottom of the viewport with no page-level scrollbar

#### Scenario: Empty chat keeps composer at the bottom
- **WHEN** the user first opens `/chat` with no turns yet
- **THEN** the composer is positioned at the bottom edge of the viewport and the empty-state hint is centered inside the message-log area, not pushing the composer down

#### Scenario: Window resize preserves the pinned composer
- **WHEN** the browser window is resized (including cross-axis and short viewports)
- **THEN** the chat surface fills exactly the new viewport height and the composer remains visible without a page-level scrollbar
