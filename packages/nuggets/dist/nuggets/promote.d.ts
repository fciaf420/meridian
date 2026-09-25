/**
 * MEMORY.md promotion — bridge nuggets to Claude Code's native memory.
 *
 * Facts recalled 3+ times across sessions are promoted to MEMORY.md
 * for permanent context inclusion.
 */
import type { NuggetShelf } from "./shelf.js";
/**
 * Promote facts with hits >= threshold to MEMORY.md.
 * Merges into existing MEMORY.md (idempotent). Returns count of
 * newly promoted facts.
 */
export declare function promoteFacts(shelf: NuggetShelf): number;
//# sourceMappingURL=promote.d.ts.map