// Pure (Readability Layer-2 P3b-1). CLI stdout -> clean summary string,
// or null when there is nothing usable (-> degrade; NEVER persist junk).
// Total: non-string -> null; never throws.
export function extractSummaryText(stdout) {
  if (typeof stdout !== 'string') return null;
  let t = stdout.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  t = t.replace(/^\s*summary\s*:\s*/i, '');
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  if (t.length === 0) return null;
  if (t.length > 600) t = t.slice(0, 600);
  return t;
}
