/**
 * UI-side detector for known secret patterns. Mirrors
 * src/tools/secretRedactor.js but runs in the browser, so the agent
 * activity stream can mask plaintext connection strings + tokens
 * before they hit the DOM.
 *
 * Returns { masked, didMask, count } — `masked` is the string to
 * display, `didMask` is a boolean we use to render a warning banner,
 * `count` is the number of distinct secrets we found.
 */
const SECRET_PATTERNS: { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
  // postgres / mysql / mongodb / redis URLs
  {
    pattern: /((?:postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?):\/\/[^:@\s]+):([^@\s]+)@/gi,
    replace: (_m, prefix) => `${prefix}:•••••••@`,
  },
  // bearer tokens
  {
    pattern: /(\bBearer\s+)([A-Za-z0-9_\-.]{16,})/gi,
    replace: (_m, prefix) => `${prefix}•••••••`,
  },
  // env-var-shaped keys in JSON
  {
    pattern: /("(?:DATABASE_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|CLIENT_SECRET)"\s*:\s*)"[^"]*"/gi,
    replace: (_m, prefix) => `${prefix}"•••••••"`,
  },
];

export function secretMask(input: string): { masked: string; didMask: boolean; count: number } {
  if (typeof input !== 'string') return { masked: '', didMask: false, count: 0 };
  let masked = input;
  let count = 0;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (...args) => {
      count += 1;
      return replace(...(args as [string, ...string[]]));
    });
  }
  return { masked, didMask: count > 0, count };
}
