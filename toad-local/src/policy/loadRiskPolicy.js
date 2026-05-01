import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load `.toad/risk-policy.json` from a project root, sync. Returns:
 *   - { rules: [...], path } when the file exists and parses
 *   - null when the file is missing, unreadable, or unparseable
 *
 * Bad rules inside an otherwise-valid JSON file are not screened here — they
 * pass through to `riskClassifier.js` which validates per-rule.
 */
export function loadRiskPolicy({ projectCwd } = {}) {
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) return null;
  const path = join(projectCwd, '.toad', 'risk-policy.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
  return { rules, path };
}
