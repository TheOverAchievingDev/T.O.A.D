// Commit 1 surface only. CompactionTrigger is added to this re-export
// in Commit 2 (Task 9). An ESM `export … from './CompactionTrigger.js'`
// for a not-yet-created module is a load-time error — do NOT add it now.
export { shouldCompact, REASONS } from './shouldCompact.js';
