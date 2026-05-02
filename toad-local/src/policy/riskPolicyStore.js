import path from 'node:path';
import { promises as fs } from 'node:fs';

/**
 * §3d Risk-policy file store. Centralises read/write of
 * `<projectCwd>/.toad/risk-policy.json` so both the runtime (which loads it
 * synchronously at startup via loadRiskPolicy.js) and the UI editor (which
 * calls these tools) speak the same shape.
 *
 * The file shape is:
 *   {
 *     rules: [
 *       { pattern: string, riskLevel?: 'low'|'medium'|'high'|'critical', requiresHumanApproval?: boolean }
 *     ],
 *     commandRules: [
 *       { pattern: string, riskLevel?: ..., requiresHumanApproval?: boolean }
 *     ]
 *   }
 */

export const VALID_RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);

export class RiskPolicyStore {
  #filePath;
  #projectCwd;

  constructor({ projectCwd } = {}) {
    if (typeof projectCwd !== 'string' || projectCwd.length === 0) {
      throw new Error('RiskPolicyStore: projectCwd is required');
    }
    this.#projectCwd = projectCwd;
    this.#filePath = path.join(projectCwd, '.toad', 'risk-policy.json');
  }

  getPath() {
    return this.#filePath;
  }

  /**
   * Read the policy file. Returns { rules: [], commandRules: [], path } when
   * the file is missing or malformed (so the editor can populate from a clean
   * slate without a separate "is it there" check).
   */
  async read() {
    try {
      const raw = await fs.readFile(this.#filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return { rules: [], commandRules: [], path: this.#filePath, exists: true, malformed: true };
      }
      return {
        rules: Array.isArray(parsed.rules) ? parsed.rules : [],
        commandRules: Array.isArray(parsed.commandRules) ? parsed.commandRules : [],
        path: this.#filePath,
        exists: true,
        malformed: false,
      };
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return { rules: [], commandRules: [], path: this.#filePath, exists: false, malformed: false };
      }
      // Read error other than ENOENT — surface as malformed so the editor can
      // still show the user what's going on.
      return { rules: [], commandRules: [], path: this.#filePath, exists: true, malformed: true };
    }
  }

  /**
   * Validate the inbound payload, then atomically replace the file. Returns
   * the cleaned-up shape that was actually written.
   */
  async write({ rules = [], commandRules = [] } = {}) {
    const cleanRules = validateRuleList(rules, 'rules');
    const cleanCommands = validateRuleList(commandRules, 'commandRules');
    const payload = {};
    if (cleanRules.length > 0) payload.rules = cleanRules;
    if (cleanCommands.length > 0) payload.commandRules = cleanCommands;
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    const tmp = `${this.#filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, this.#filePath);
    return { rules: cleanRules, commandRules: cleanCommands, path: this.#filePath };
  }
}

function validateRuleList(list, label) {
  if (!Array.isArray(list)) {
    throw new Error(`${label} must be an array`);
  }
  return list.map((rule, i) => validateRule(rule, label, i));
}

function validateRule(rule, label, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${label}[${index}] must be an object`);
  }
  const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : '';
  if (pattern.length === 0) {
    throw new Error(`${label}[${index}].pattern must be a non-empty string`);
  }
  const out = { pattern };
  if (rule.riskLevel !== undefined && rule.riskLevel !== null && rule.riskLevel !== '') {
    if (!VALID_RISK_LEVELS.includes(rule.riskLevel)) {
      throw new Error(`${label}[${index}].riskLevel must be one of ${VALID_RISK_LEVELS.join(',')}`);
    }
    out.riskLevel = rule.riskLevel;
  }
  if (rule.requiresHumanApproval === true) {
    out.requiresHumanApproval = true;
  }
  if (out.riskLevel === undefined && !out.requiresHumanApproval) {
    throw new Error(
      `${label}[${index}] must set at least riskLevel or requiresHumanApproval=true`,
    );
  }
  return out;
}
