/** Minimal shape the board-tab rules read. Kept separate so both the page's
 *  Block type and node tests can satisfy it without importing React. */
export interface BlockLike {
  error?: string
  tab?: string
}
