/**
 * Pure risk classifier for §14.
 *
 * Given a list of changed files and a project's risk policy, decide whether
 * the task's `riskLevel` should be elevated and whether `requiresHumanApproval`
 * should be flipped on. The classifier never demotes — operator-supplied
 * baselines from `task_create` are always preserved or raised.
 *
 * No I/O. The loader (`loadRiskPolicy.js`) is responsible for producing the
 * policy object from disk.
 */

export const RISK_LEVEL_ORDER = Object.freeze(['low', 'medium', 'high', 'critical']);

export function classify({
  files,
  policy,
  currentRiskLevel = null,
  currentRequiresHumanApproval = false,
} = {}) {
  const fileList = Array.isArray(files) ? files.filter((f) => typeof f === 'string' && f.length > 0) : [];
  const rules = policy && Array.isArray(policy.rules) ? policy.rules : [];

  let highestRank = riskRank(currentRiskLevel);
  let highestLevel = currentRiskLevel || null;
  let approvalFlag = currentRequiresHumanApproval === true;
  const matchedRules = [];

  for (const rule of rules) {
    if (!isValidRule(rule)) continue;
    const hits = fileList.some((file) => matchesPattern(file, rule.pattern));
    if (!hits) continue;

    if (typeof rule.riskLevel === 'string' && RISK_LEVEL_ORDER.includes(rule.riskLevel)) {
      const rank = riskRank(rule.riskLevel);
      if (rank > highestRank) {
        highestRank = rank;
        highestLevel = rule.riskLevel;
      }
    }
    if (rule.requiresHumanApproval === true) approvalFlag = true;
    matchedRules.push({
      pattern: rule.pattern,
      ...(typeof rule.riskLevel === 'string' && RISK_LEVEL_ORDER.includes(rule.riskLevel) ? { riskLevel: rule.riskLevel } : {}),
      ...(rule.requiresHumanApproval === true ? { requiresHumanApproval: true } : {}),
    });
  }

  return {
    riskLevel: highestLevel,
    requiresHumanApproval: approvalFlag,
    matchedRules,
  };
}

function isValidRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) return false;
  // A rule must declare at least one effect — either a valid riskLevel or
  // requiresHumanApproval:true. Otherwise it's a no-op and we drop it so it
  // doesn't appear in `matchedRules`.
  const hasValidLevel = typeof rule.riskLevel === 'string' && RISK_LEVEL_ORDER.includes(rule.riskLevel);
  const requiresApproval = rule.requiresHumanApproval === true;
  if (!hasValidLevel && !requiresApproval) return false;
  return true;
}

function riskRank(level) {
  if (typeof level !== 'string') return -1;
  const idx = RISK_LEVEL_ORDER.indexOf(level);
  return idx;
}

function matchesPattern(file, pattern) {
  if (typeof file !== 'string' || typeof pattern !== 'string') return false;
  if (file === pattern) return true;

  // Recursive descendant glob: `prefix/**` matches anything under prefix/.
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    if (prefix.length === 0) return true; // `/**` — match everything
    if (file === prefix) return true;
    if (file.startsWith(prefix + '/')) return true;
    return false;
  }

  // Directory prefix: `config/` matches anything under config/.
  if (pattern.endsWith('/')) {
    return file.startsWith(pattern);
  }

  // Recursive any-depth tail glob: `**/<rest>` matches file at any depth where
  // basename or path-segment ending matches `<rest>`. We handle the common
  // case `<rest>` starts with `*.` (extension glob) — file must end with the
  // suffix after `*`.
  if (pattern.startsWith('**/')) {
    const rest = pattern.slice(3);
    if (rest.length === 0) return true;
    if (rest.startsWith('*')) {
      const suffix = rest.slice(1);
      return file.endsWith(suffix);
    }
    // `**/<exact>` matches any path whose final segment === <exact>
    return file === rest || file.endsWith('/' + rest);
  }

  // Trailing wildcard: `.env*` matches `.env`, `.env.production`, etc.
  if (pattern.endsWith('*') && !pattern.endsWith('**')) {
    const prefix = pattern.slice(0, -1);
    return file.startsWith(prefix);
  }

  return false;
}
